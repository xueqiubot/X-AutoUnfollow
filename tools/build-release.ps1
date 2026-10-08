# 打包 Chrome 扩展 release zip
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1 -Version 1.1.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1 -Flat
#
# 产物：dist/X-AutoUnfollow-v<version>.zip
#
# 默认布局（推荐）：zip 内套一层同名文件夹
#   X-AutoUnfollow-v1.0.0/manifest.json
#   X-AutoUnfollow-v1.0.0/sidepanel/...
#   → 「解压到当前文件夹」不会把文件散落一地；解压后直接选中该文件夹
#     用「加载已解压的扩展程序」载入即可。
#
# -Flat：不套文件夹，manifest.json 直接位于 zip 根目录（旧行为）。
#
# 发布纪律：默认拒绝在「工作区不干净」（有未提交改动）时打包 —— 否则会把未提交的
# README 之类的改动打进包里，而 zip 看起来又完全正常。确需临时打包用 -AllowDirty。
#
# 仅包含运行期文件（tools/ 等开发期资源不打包）。
#
# 实现要点：
#   - 用 .NET ZipArchive 手写条目，条目名统一为正斜杠（Compress-Archive 在
#     Windows PowerShell 5.1 会写入反斜杠，不符合 ZIP 规范，Linux/macOS 解压会出错）。
#   - 条目时间戳固定 1980-01-01，使相同输入产出字节一致的 zip。
#   - 本文件必须保存为「UTF-8 带 BOM」：Windows PowerShell 5.1 对无 BOM 的
#     UTF-8 脚本按 ANSI 解码，会把下面这些中文注释读乱并直接语法报错。

[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Flat,
  [switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$root = Split-Path -Parent $PSScriptRoot   # 扩展根目录
if (-not $Version) {
  # 必须显式 -Encoding UTF8：Windows PowerShell 5.1 默认按 ANSI 读文本，会把中文描述读乱导致 JSON 解析失败
  $Version = (Get-Content (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
if (-not $Version) { throw '无法确定版本号：manifest.json 缺少 version 字段' }

# 发布纪律：zip 应只来自已提交内容。工作区有未提交改动时拒绝打包，避免把未提交的
# README 等改动打进包里 —— 这种 zip 表面完全正常，肉眼和哈希都看不出问题。
if ((Test-Path (Join-Path $root '.git')) -and -not $AllowDirty) {
  $dirty = @(& git -C $root status --porcelain 2>$null)
  if ($LASTEXITCODE -eq 0 -and $dirty.Count -gt 0) {
    throw "工作区不干净，拒绝打包。请先提交改动，或加 -AllowDirty 强行打包。未提交项：`n  $($dirty -join "`n  ")"
  }
}

$name  = "X-AutoUnfollow-v$Version"
$dist  = Join-Path $root 'dist'
$stage = Join-Path $dist $name
$zip   = Join-Path $dist "$name.zip"

# zip 内条目前缀：默认套一层同名文件夹，-Flat 时不套
$prefix = if ($Flat) { '' } else { "$name/" }
$layout = if ($Flat) { '平铺' } else { "套文件夹 $name/" }

# 参与打包的运行期文件 / 目录
$include = @('manifest.json', 'background.js', 'README.md', 'profile-avatar.jpg', 'content', 'sidepanel', 'icons')

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($item in $include) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { throw "缺少打包资源：$item" }
  Copy-Item $src -Destination $stage -Recurse -Force
}

if (Test-Path $zip) { Remove-Item $zip -Force }

$rootLen = $stage.Length + 1
$files = Get-ChildItem -Path $stage -Recurse -File | Sort-Object FullName

$fs   = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
$arch = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($f in $files) {
    $rel = $prefix + $f.FullName.Substring($rootLen).Replace('\', '/')
    $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [datetimeoffset]::new(1980, 1, 1, 0, 0, 0, [timespan]::Zero)
    $es = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $es.Write($bytes, 0, $bytes.Length)
    } finally { $es.Dispose() }
  }
} finally { $arch.Dispose(); $fs.Dispose() }

# 校验：manifest.json 必须在期望位置，且条目名全部为正斜杠、无多余层级
$manifestEntry = "${prefix}manifest.json"
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = @($check.Entries | ForEach-Object { $_.FullName })
  if ($names -notcontains $manifestEntry) { throw "打包结果缺少 $manifestEntry" }
  if ($names | Where-Object { $_ -match '\\' }) { throw '打包结果存在反斜杠条目名' }
  if ($names | Where-Object { $_ -notlike "$prefix*" }) { throw "打包结果存在 $prefix 之外的条目" }
  # 去掉前缀后：顶层文件不应带斜杠，目录内文件只允许一层（content|sidepanel|icons）
  $stripped = $names | ForEach-Object { $_ -replace "^$([regex]::Escape($prefix))", '' }
  $deep = $stripped | Where-Object { $_ -match '/' -and $_ -notmatch '^(content|sidepanel|icons)/[^/]+$' }
  if ($deep) { throw "打包结果层级异常：$($deep -join ', ')" }
} finally { $check.Dispose() }

$size = (Get-Item $zip).Length
Write-Host "已生成：dist/$name.zip  ($([math]::Round($size/1KB,1)) KB, $($files.Count) 个文件, 布局=$layout)"
Write-Host "引导入口：解压后选中含 manifest.json 的目录 —— $manifestEntry"

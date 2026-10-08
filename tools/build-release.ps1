# 打包 Chrome 扩展 release zip
#
# 用法：
#   pwsh -File tools/build-release.ps1            # 版本号取 manifest.json 的 version
#   pwsh -File tools/build-release.ps1 -Version 1.1.0
#
# 产物：dist/X-AutoUnfollow-v<version>.zip
#   zip 根目录即 manifest.json，解压后可直接「加载已解压的扩展程序」。
#   仅包含运行期文件（tools/ 等开发期资源不打包）。
#
# 实现要点：
#   - 用 .NET ZipArchive 手写条目，条目名统一为正斜杠（Compress-Archive 在部分
#     PowerShell 版本会写入反斜杠，不符合 ZIP 规范，Linux/macOS 解压会出错）。
#   - 条目时间戳固定 1980-01-01，使相同输入产出字节一致的 zip。

[CmdletBinding()]
param(
  [string]$Version
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

$name  = "X-AutoUnfollow-v$Version"
$dist  = Join-Path $root 'dist'
$stage = Join-Path $dist $name
$zip   = Join-Path $dist "$name.zip"

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
    $rel = $f.FullName.Substring($rootLen).Replace('\', '/')
    $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [datetimeoffset]::new(1980, 1, 1, 0, 0, 0, [timespan]::Zero)
    $es = $entry.Open()
    try {
      $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
      $es.Write($bytes, 0, $bytes.Length)
    } finally { $es.Dispose() }
  }
} finally { $arch.Dispose(); $fs.Dispose() }

# 校验：manifest.json 必须在 zip 根目录
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $names = $check.Entries | ForEach-Object { $_.FullName }
  if ($names -notcontains 'manifest.json') { throw '打包结果缺少根目录 manifest.json' }
  if ($names | Where-Object { $_ -match '\\' }) { throw '打包结果存在反斜杠条目名' }
} finally { $check.Dispose() }

$size = (Get-Item $zip).Length
Write-Host "已生成：dist/$name.zip  ($([math]::Round($size/1KB,1)) KB, $($files.Count) 个文件)"

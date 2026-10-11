# X 自动取关助手（Chrome 侧边栏扩展）

在 X (Twitter) 的「正在关注」页面上，**高亮标出没有回关你的用户**以便手动取关，
也可按**白名单**与**互关保护**规则安全地批量自动取关。
Chrome Extension Manifest V3 + `chrome.sidePanel`，全程本地运行，不依赖任何外部服务。

---

## 一、安装

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的那一层）
4. 工具栏出现扩展图标后，点击图标即可唤起侧边栏（也可用 `Ctrl+Shift+Y` 需自行绑定快捷键）

> 需要 Chrome 116 及以上（`chrome.sidePanel` 的 `openPanelOnActionClick`）。

## 二、使用

1. 浏览器打开 **`https://x.com/{你的用户名}/following`**（X 的「正在关注」页面）
2. 侧边栏顶部环境指示应变为绿色 **「已就绪：正在关注页面」**
3. 想自己一个个取关 → 点 **标记未互关用户**（见第三点六节，页面会标红未回关你的人）
4. 想批量自动取关 → 按需配置：
   - **互关保护**（默认开）：检测到 `Follows you / 关注了你` 的用户会被跳过
   - **白名单**：输入 `@handle` 后回车，支持逗号 / 空格批量粘贴；点标签上的 `✕` 删除
   - **取关间隔**：默认 5 – 10 秒随机浮动
   - **单次最大取关数**：默认 50
   - **演练模式**：只扫描、只统计，不产生任何点击（建议首次使用先跑一次）
5. 点 **开始自动取关**；随时点 **停止** 可立即中断

配置会写入 `chrome.storage.local`，下次打开自动恢复。

## 三、安全机制

| 机制 | 说明 |
| --- | --- |
| 随机延迟 | 每次取关间隔在设定区间内随机浮动（默认 5–10s） |
| 单次熔断 | 达到「单次最大取关数」立即停止 |
| 错误退避 | 连续 3 次失败 → 暂停 30s 后重试，并向侧边栏上报 |
| 自动熔断 | 连续 6 次失败 → 自动停止任务 |
| 去重 | 以 `@handle` 为键记录已扫描用户，滚动加载不会重复操作 |
| 演练模式 | 全链路跑通但不点击，用于验证过滤规则是否符合预期 |
| 运行锁定 | 任务运行期间锁定配置项，避免中途改参数导致上下游口径不一致 |

## 三点五、作者卡片

侧边栏顶栏下方有一张**作者卡片**（与 `x-自动运营` 同逻辑）：展示作者头像 / 显示名 /
一行简介，右侧一个「关注」快捷按钮，点作者名旁的 `↗` 可新标签打开主页。

- 点「关注」→ 后台打开作者主页并自动关注；成功（含「已关注过」）→ 卡片**永久隐藏**（`followed` 落盘）
- 找不到关注入口 / 点击未生效 → 保留卡片并提示，可重试
- 卡片底部小字 → **仅本次会话内隐藏**（不落盘，重开侧边栏恢复）

> 该卡片已抽成可复用组件包，见工作区根目录 `作者卡片组件/`。

## 三点六、未互关标记（手动取关）

不想让脚本替你点按钮时，用这条「只标记、不动手」的路径：点侧边栏 **标记未互关用户**，
扩展会在页面上给每个用户打上颜色标签，取关动作完全由你自己点 X 页面上的「正在关注」按钮完成。

| 页面标记 | 含义 |
| --- | --- |
| 🔴 **未互关** | 对方没有回关你 —— 要清理的就是这些人（整行淡红底 + 左侧红条） |
| 🟢 **互关** | 对方关注了你，正常情况建议保留 |
| 🔵 **白名单** | 在白名单里，即使未互关也不标红（避免手滑） |
| ⚪ **已取关** | 你刚手动取关的人 —— 整行变灰，方便确认操作已生效 |

- 侧边栏实时统计 **未互关 / 互关 / 白名单 / 已取关** 四类人数（按 `@handle` 去重，滚过就记住）
- 标记**随滚动持续生效**：X 的关注列表是虚拟滚动（节点会被回收复用），
  扩展用 `MutationObserver` + 定时兜底反复扫描，滚到哪标到哪，节点复用后也会补回标记
- 标记只写在节点的 `class` / `data-*` 上、徽标用 CSS `::after` 渲染，**不插入子节点**，
  不会打乱 X 的布局，也不会和 React 的渲染打架
- 点击 **停止标记** 会立刻清除页面上所有标记（按钮回到「标记未互关用户」）
- 开启状态写入 `chrome.storage.local`：**刷新页面或重开侧边栏会自动恢复标记**，不用每次重开
- 与自动取关**互不干扰，可同时开启**（自动任务跑着时也能手动清理剩下的）
- 白名单只影响「标不标红」：手动取关完全由你决定，扩展不会（也无法）阻拦你点哪一行

> 判定依据是 X 在关注列表里显示的 `Follows you / 关注了你 / 跟隨了你` 标签，
> 没有这个标签即视为未互关；X 若改版需要同步 `content/content-script.js` 里的文案常量。

## 四、目录结构

```
x-取关助手/
├── manifest.json            # MV3 配置与权限声明
├── background.js            # Service Worker：生命周期 + 三方消息总线
├── sidepanel/
│   ├── index.html           # 侧边栏 UI（含作者卡片 + 未互关标记 + toast）
│   ├── style.css            # X 深色风格样式
│   └── sidepanel.js         # 交互逻辑 / 配置持久化 / 状态同步 / 作者卡片
├── content/
│   └── content-script.js    # 页面注入脚本：解析 / 过滤 / 取关 / 滚动 / 关注作者 / 未互关标记
├── profile-avatar.jpg       # 作者卡头像
├── icons/                   # 16 / 48 / 128 图标
└── tools/                   # 开发期工具（不参与扩展运行）
    ├── gen_icons.py         # 图标生成（纯标准库）
    ├── build-release.ps1    # 打包 release zip
    ├── test-content-script.cjs   # jsdom 端到端测试（含未互关标记）
    ├── test-follow-profile.cjs   # 作者卡片关注逻辑测试
    └── test-sidepanel-highlight.cjs  # 侧边栏「未互关标记」链路测试
```

## 五、选择器与多语言适配

`content/content-script.js` 顶部集中了所有选择器与文案，X 前端改版时只需改这里：

```js
const SEL = {
  USER_CELL:    '[data-testid="UserCell"]',
  CONFIRM:      '[data-testid="confirmationSheetConfirm"]',
  UNFOLLOW_BTN: '[data-testid$="-unfollow"], [data-testid="unfollow"]',  // 现代版为 {rest_id}-unfollow
  FOLLOW_BTN:   '[data-testid$="-follow"]',
};
```

- `@handle` 解析：优先取 `href="/handle"` 形式的链接，失败则从文本中正则兜底
- 互关标识：同时匹配 `Follows you` / `关注了你` / `跟隨了你`
- 操作按钮：优先 `data-testid`，失败则按文案 `Following / 正在关注 / Unfollow / 取消关注` 兜底
- 确认弹窗：优先 `data-testid="confirmationSheetConfirm"`，失败则在弹窗内按 `Unfollow / 取消关注` 文案查找
- 未互关标记：四态文案在 `HL_KINDS`、页面内样式在 `HL_CSS`（徽标走 `::after` + `data-xuf-tag`），
  判定范围仍是 `SEL.USER_CELL`；X 若改版只需同步这两处常量

## 六、开发期验证

```bash
# 语法检查
node --check background.js
node --check sidepanel/sidepanel.js
node --check content/content-script.js

# 端到端测试（需要 jsdom）
NODE_PATH=<node_workspace>/node_modules node tools/test-content-script.cjs

# 作者卡片关注逻辑测试
NODE_PATH=<node_workspace>/node_modules node tools/test-follow-profile.cjs

# 侧边栏「未互关标记」链路测试（chrome API 打桩）
NODE_PATH=<node_workspace>/node_modules node tools/test-sidepanel-highlight.cjs
```

测试用 jsdom 模拟 X 页面 DOM，覆盖：中英文界面、互关保护开关、白名单、
单次上限、演练模式、滚动懒加载与去重、STOP 中断、连续失败熔断、非目标页面拒绝；
未互关标记的三态判定与计数、手动取关后转「已取关」、关闭后清理标记、动态新增节点自动标记；
以及作者卡片的 `followed / already / unavailable / failed` 四种结果。

## 七、打包发布

```powershell
# 默认：zip 内套一层同名文件夹（推荐）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1

# 显式指定版本号
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1 -Version 1.1.0

# 平铺：manifest.json 直接位于 zip 根目录
powershell -NoProfile -ExecutionPolicy Bypass -File tools/build-release.ps1 -Flat
```

产物 `dist/X-AutoUnfollow-v<version>.zip`，**默认套一层同名文件夹**：

```
X-AutoUnfollow-v1.0.0/
├── manifest.json
├── background.js
├── README.md
├── profile-avatar.jpg
├── content/ · sidepanel/ · icons/
```

这样「解压到当前文件夹」不会把十几个文件散落一地，解压后直接选中
`X-AutoUnfollow-v1.0.0/` 那一层用「加载已解压的扩展程序」载入即可。
`-Flat` 保留旧的平铺布局（manifest 在 zip 根目录），适合要求根目录即扩展根的分发工具链。

仅含运行期文件（`tools/`、`.workbuddy/` 等开发期资源不入包）。
脚本用 .NET `ZipArchive` 手写条目（条目名统一正斜杠，时间戳固定 1980-01-01），
相同输入产出字节一致的 zip。

> Windows PowerShell 5.1 默认按 ANSI 读取无 BOM 的 UTF-8 文本，
> 因此 `tools/build-release.ps1` **必须保存为 UTF-8 带 BOM**，读取 `manifest.json` 时也显式指定了 `-Encoding UTF8`。

## 八、已知限制

- 页面结构依赖 X 的 `data-testid`，X 若大改版可能需同步更新选择器（见第五节）
- 标签页处于后台但未休眠时脚本仍会执行；若标签页被浏览器彻底冻结，任务会暂停（侧边栏看门狗会在失联时把状态拉回）
- 不建议无人值守长时间挂着跑，单次上限建议不超过 100

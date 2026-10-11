/* ==========================================================================
   content/content-script.js — 页面注入脚本
   职责：DOM 识别 / 条件过滤 / 模拟取关 / 平滑滚动 / 熔断退避 / 中断响应
   适配：X (x.com) 中英文界面
   ========================================================================== */
(() => {
  "use strict";

  // 防止重复注入（SPA 场景 + background 兜底注入）
  if (window.__xufLoaded) return;
  window.__xufLoaded = true;

  // ================================================================ 常量
  const SEL = {
    USER_CELL: '[data-testid="UserCell"]',
    CONFIRM: '[data-testid="confirmationSheetConfirm"]',
    CONFIRM_DIALOG: '[data-testid="confirmationSheetDialog"]',
    // 关注中按钮：现代版本为 `{rest_id}-unfollow`，部分版本为纯 `unfollow`
    UNFOLLOW_BTN: '[data-testid$="-unfollow"], [data-testid="unfollow"]',
    FOLLOW_BTN: '[data-testid$="-follow"]',
    // 个人主页主栏（作者卡关注按钮的定位范围）
    PRIMARY_COLUMN: '[data-testid="primaryColumn"]',
  };

  // 多语言文案（简体 / 繁体 / 英文）
  const TEXT = {
    following: ["following", "正在关注", "正在跟隨", "正在關注"],
    follow: ["follow", "关注", "跟隨", "關注"],
    unfollow: ["unfollow", "取消关注", "取消跟隨", "取消關注"],
  };

  const FOLLOWING_RE = /^\/([^/]+)\/following\/?$/i;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  // 可被测试夹具覆盖的时序参数（生产环境使用默认值）
  const T = (typeof window !== "undefined" && window.__XUF_TEST__) || {};
  const CONFIRM_TIMEOUT = Number(T.confirmTimeoutMs) || 6000;
  const STATE_TIMEOUT = Number(T.stateChangeTimeoutMs) || 8000;
  const BACKOFF_MS = Number(T.backoffMs) || 30000;
  const MAX_CONSECUTIVE_WARN = Number(T.maxConsecutiveWarn) || 3;
  const MAX_CONSECUTIVE_STOP = Number(T.maxConsecutiveStop) || 6;
  const SCROLL_SETTLE_MS = Number(T.scrollSettleMs) || 1200;
  const SCROLL_WAIT_MS = Number(T.scrollWaitMs) || 3000;

  // ================================================================ 配置
  const DEFAULT_CONFIG = {
    whitelist: [],
    protectMutual: true,
    delayMin: 5000,
    delayMax: 10000,
    maxUnfollow: 50,
    dryRun: false,
  };
  const config = { ...DEFAULT_CONFIG };

  // ================================================================ 状态
  const state = {
    running: false,
    stopRequested: false,
    status: "待机",
    scanned: 0,
    unfollowed: 0,
    skippedWhitelist: 0,
    skippedMutual: 0,
    failed: 0,
    consecutiveErrors: 0,
    currentHandle: null,
    maxUnfollow: DEFAULT_CONFIG.maxUnfollow,
    dryRun: false,
  };

  const scannedHandles = new Set(); // 去重：已扫描过的 handle
  let whitelistSet = new Set();

  // ================================================================ 工具
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function randBetween(min, max) {
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min));
  }

  async function waitFor(predicate, timeout = 5000, interval = 120) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = predicate();
        if (v) return v;
      } catch (_) {
        /* 忽略瞬时异常，继续轮询 */
      }
      if (state.stopRequested) return null;
      await sleep(interval);
    }
    return null;
  }

  function isFollowingPage() {
    return FOLLOWING_RE.test(location.pathname);
  }

  function normText(s) {
    return String(s || "").replace(/\s+/g, "").toLowerCase();
  }

  function hasAnyText(node, list) {
    const t = normText(node.textContent);
    return list.some((w) => t.includes(normText(w)));
  }

  // ================================================================ 上报
  function emitState(statusText) {
    if (statusText) state.status = statusText;
    send({ kind: "STATE", data: snapshot() });
  }

  function snapshot() {
    return {
      running: state.running,
      status: state.status,
      scanned: state.scanned,
      unfollowed: state.unfollowed,
      skippedWhitelist: state.skippedWhitelist,
      skippedMutual: state.skippedMutual,
      failed: state.failed,
      currentHandle: state.currentHandle,
      maxUnfollow: state.maxUnfollow,
      dryRun: state.dryRun,
      highlight: hlSnapshot(),
    };
  }

  function log(message, level = "") {
    send({ kind: "LOG", data: { message, level } });
  }

  function send(payload) {
    try {
      chrome.runtime.sendMessage({ to: "background", from: "content", ...payload });
    } catch (_) {
      /* 扩展被重载时会抛错，忽略 */
    }
  }

  // ================================================================ 解析
  /** 从 UserCell 中解析出 handle / 互关标识 / 操作按钮 */
  function parseCell(cell) {
    // 1) 用户名（@handle）：取 href 形如 "/handle" 的链接
    let handle = null;
    const links = cell.querySelectorAll('a[href^="/"]');
    for (const a of links) {
      const href = (a.getAttribute("href") || "").split("?")[0];
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (m && HANDLE_RE.test(m[1])) {
        handle = m[1];
        break;
      }
    }
    if (!handle) {
      // 兜底：从文本里抓 @handle
      const m = (cell.textContent || "").match(/@([A-Za-z0-9_]{1,15})/);
      if (m) handle = m[1];
    }

    // 2) 互关标识
    const txt = cell.textContent || "";
    const followsYou =
      /follows\s*you/i.test(txt) || /关注了你/.test(txt) || /跟隨了你/.test(txt) || /關注了你/.test(txt);

    // 3) 操作按钮
    let btn = cell.querySelector(SEL.UNFOLLOW_BTN);
    if (!btn) {
      // 文本兜底：正在关注 / Following / 取消关注 / Unfollow
      btn = findButtonByText(cell, [...TEXT.following, ...TEXT.unfollow]);
    }

    return { handle, followsYou, btn, cell };
  }

  function findButtonByText(root, labels) {
    const candidates = root.querySelectorAll('button, [role="button"]');
    for (const b of candidates) {
      const t = normText(b.textContent);
      if (!t) continue;
      if (labels.some((l) => t === normText(l))) return b;
    }
    return null;
  }

  // ================================================================ 取关
  function findConfirmButton() {
    let btn = document.querySelector(SEL.CONFIRM);
    if (btn) return btn;
    // 兜底：在确认弹窗内按文案查找
    const dialog = document.querySelector(SEL.CONFIRM_DIALOG) || document;
    return findButtonByText(dialog, TEXT.unfollow);
  }

  function isNowFollowing(cell) {
    // 取关成功后，按钮应当变成「关注 / Follow」
    if (cell.querySelector(SEL.FOLLOW_BTN)) return true;
    const btn = findButtonByText(cell, TEXT.follow);
    return !!btn;
  }

  /** 执行单个用户的取关，返回 true 表示成功 */
  async function unfollowUser(info) {
    // 演练模式：不产生任何点击
    if (state.dryRun) {
      log(`[演练] 将取关 @${info.handle}`, "warn");
      await sleep(randBetween(150, 400));
      return true;
    }

    info.btn.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(randBetween(250, 550));

    info.btn.click();

    // 等待确认弹窗
    const confirmBtn = await waitFor(findConfirmButton, CONFIRM_TIMEOUT);
    if (!confirmBtn) throw new Error("未找到确认取关弹窗");

    await sleep(randBetween(300, 700));
    confirmBtn.click();

    // 等待 DOM 状态变更（按钮由 正在关注 -> 关注）
    const ok = await waitFor(() => isNowFollowing(info.cell), STATE_TIMEOUT);
    if (!ok) throw new Error("取关后未检测到按钮状态变更");

    return true;
  }

  // =============================================== 关注作者主页（作者卡片）
  // 与 x-自动运营 的 followProfileOnPage / profile-probe 同逻辑：
  //   - 先校验当前 URL 确实停在目标 handle 的主页（SPA 可能还没渲染完）；
  //   - 关注按钮**不在推文块里**，而位于页面头部资料区，故限定在 primaryColumn 内定位；
  //   - 资料区关注入口可能不止一个（侧边推荐栏、迷你按钮），取「可见且最宽」的那个；
  //   - 已关注：资料区存在可见 unfollow 按钮 → already；
  //   - 点击后**校验状态翻转**（出现 unfollow）才判 followed，不做无条件报成功。

  /** X 的保留路径段，不能当作「某个用户的主页」 */
  const RESERVED_FIRST_SEGMENT = /^(home|explore|notifications|messages|settings|search|compose|i)$/;

  function isProfilePathFor(handle) {
    const seg = (location.pathname.split("/").filter(Boolean)[0]) || "";
    if (!seg || RESERVED_FIRST_SEGMENT.test(seg)) return false;
    return seg.toLowerCase() === String(handle || "").replace(/^@/, "").trim().toLowerCase();
  }

  /** 收集作用域内可见的 follow / unfollow 按钮（宽高 > 0） */
  function collectProfileButtons(scope, kind) {
    const q = kind === "follow" ? SEL.FOLLOW_BTN : '[data-testid$="-unfollow"], [data-testid="unfollow"]';
    return Array.from(scope.querySelectorAll(q)).filter((el) => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (_) {
        return false;
      }
    });
  }

  /** 取可见候选中宽度最大的 —— 资料区按钮通常比迷你按钮宽 */
  function pickProfileButton(scope, kind) {
    const cands = collectProfileButtons(scope, kind);
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    return cands
      .slice()
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  }

  /**
   * 关注「个人主页」上的作者。
   * @returns {Promise<'followed'|'already'|'unavailable'|'failed'>}
   */
  async function followProfileOnPage(handle) {
    if (!isProfilePathFor(handle)) {
      // 页面尚未切到目标主页（SPA 还在渲染 / 停在别处），交由上层重试或提示
      return "unavailable";
    }

    const primary = document.querySelector(SEL.PRIMARY_COLUMN) || document.body;

    // 已关注：资料区存在 unfollow 按钮
    if (pickProfileButton(primary, "unfollow")) return "already";

    const followBtn = pickProfileButton(primary, "follow");
    if (!followBtn) return "unavailable";

    followBtn.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(randBetween(250, 550));
    followBtn.click();
    await sleep(randBetween(600, 1400));

    // 校验状态翻转：点完必须出现 unfollow，否则视为失败
    return pickProfileButton(primary, "unfollow") ? "followed" : "failed";
  }

  // ================================================================ 过滤
  async function handleCell(cell) {
    const info = parseCell(cell);

    if (!info.handle) {
      state.scanned++;
      emitState();
      return "no-handle";
    }

    const key = info.handle.toLowerCase();
    if (scannedHandles.has(key)) return "duplicate";
    scannedHandles.add(key);
    state.scanned = scannedHandles.size;
    emitState();
    state.currentHandle = info.handle;

    // 命中白名单 -> 跳过
    if (whitelistSet.has(key)) {
      state.skippedWhitelist++;
      emitState();
      log(`跳过白名单 @${info.handle}`);
      return "whitelist";
    }

    // 互关保护 -> 跳过
    if (config.protectMutual && info.followsYou) {
      state.skippedMutual++;
      emitState();
      log(`跳过互关 @${info.handle}`);
      return "mutual";
    }

    if (!info.btn) {
      log(`未找到 @${info.handle} 的操作按钮，跳过`, "warn");
      return "no-button";
    }

    // 执行取关
    try {
      await unfollowUser(info);
      state.unfollowed++;
      state.consecutiveErrors = 0;
      emitState();
      log(`已取关 @${info.handle}${state.dryRun ? "（演练）" : ""}`, "ok");
      await randomDelay();
      return "unfollowed";
    } catch (err) {
      state.failed++;
      state.consecutiveErrors++;
      emitState();
      log(`取关 @${info.handle} 失败：${err.message}`, "err");

      // 错误退避
      if (state.consecutiveErrors >= MAX_CONSECUTIVE_WARN) {
        log(`连续 ${state.consecutiveErrors} 次失败，暂停 ${BACKOFF_MS / 1000}s 后重试`, "warn");
        emitState("退避中");
        await interruptibleSleep(BACKOFF_MS);
        emitState("运行中");
      }
      // 熔断
      if (state.consecutiveErrors >= MAX_CONSECUTIVE_STOP) {
        state.stopRequested = true;
        log("连续失败过多，已自动熔断停止", "err");
      }
      return "failed";
    }
  }

  function randomDelay() {
    const ms = randBetween(config.delayMin, config.delayMax);
    log(`等待 ${(ms / 1000).toFixed(1)}s…`);
    return interruptibleSleep(ms);
  }

  /** 可被 STOP 打断的睡眠 */
  async function interruptibleSleep(ms) {
    const step = 200;
    let elapsed = 0;
    while (elapsed < ms && !state.stopRequested) {
      const chunk = Math.min(step, ms - elapsed);
      await sleep(chunk);
      elapsed += chunk;
    }
  }

  // ================================================================ 滚动
  function countCells() {
    return document.querySelectorAll(SEL.USER_CELL).length;
  }

  function isInViewport(node) {
    const r = node.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight);
  }

  /** 向下滚动并等待新内容，返回 { grew, moved } */
  async function scrollAndLoad() {
    const beforeCount = countCells();
    const beforeY = window.scrollY;

    window.scrollBy(0, 800);
    await sleep(SCROLL_SETTLE_MS);

    // 等待动态数据加载
    await waitFor(() => countCells() > beforeCount, SCROLL_WAIT_MS);

    return {
      grew: countCells() > beforeCount,
      moved: window.scrollY > beforeY,
    };
  }

  // ================================================================ 主循环
  function reachedLimit() {
    return state.unfollowed >= state.maxUnfollow;
  }

  async function mainLoop() {
    log(`开始扫描（上限 ${state.maxUnfollow} 个${state.dryRun ? "，演练模式" : ""}）`);
    emitState("运行中");

    let idleScrolls = 0;

    while (!state.stopRequested) {
      if (reachedLimit()) {
        log(`已达到单次上限 ${state.maxUnfollow}，停止`, "warn");
        break;
      }

      // 取当前视窗内尚未处理的卡片；若视窗内没有，则退回全量未处理卡片
      const pending = [...document.querySelectorAll(SEL.USER_CELL)].filter(
        (c) => !c.dataset.xufProcessed
      );
      const visible = pending.filter(isInViewport);
      const targets = visible.length ? visible : pending;

      if (!targets.length) {
        // 无待处理卡片 -> 滚动加载
        const { grew, moved } = await scrollAndLoad();
        idleScrolls = grew ? 0 : idleScrolls + 1;

        // 既没滚动也没新增 -> 到底了；连续多次滚动都没有新用户 -> 判定列表已耗尽
        if ((!grew && !moved) || idleScrolls >= 4) {
          log("没有更多可处理的用户，任务结束", "warn");
          break;
        }
        continue;
      }

      idleScrolls = 0;
      for (const cell of targets) {
        if (state.stopRequested || reachedLimit()) break;
        cell.dataset.xufProcessed = "1";
        await handleCell(cell);
      }
    }
  }

  // ================================================================ 未互关标记
  // 「未互关标记」模式：把正在关注列表里**没有回关你**的用户在页面上标红，
  // 由用户自己点页面上的取关按钮手动取关。与自动取关互不干扰，可同时开启。
  //
  // 实现要点：
  //  - X 的关注列表是虚拟滚动（DOM 节点会被回收复用），只在 DOM 变更时打一次标是不够的，
  //    必须「MutationObserver + 定时兜底」反复扫描当前 DOM，并用 data-xuf-mark 记住
  //    每个 cell 已打的标，避免重复写 DOM；
  //  - 标记只落在 cell 自身的 class / data-* 上，徽标用 CSS ::after 渲染（不插入子节点），
  //    既不会被 React 的 diff 冲掉，也不会打乱 X 的原有布局；
  //  - 计数按 @handle 去重累计（滚过就记住），数字只随浏览增长，不会因节点回收而抖动。

  const HL = {
    STYLE_ID: "xuf-highlight-style",
    MARK_ATTR: "data-xuf-mark",
    TAG_ATTR: "data-xuf-tag",
    SIG_ATTR: "data-xuf-sig",
    // 关注状态只看按钮，一个选择器搞定（用于快路径比对）
    BTN_SEL: `${SEL.UNFOLLOW_BTN}, ${SEL.FOLLOW_BTN}`,
    SCAN_THROTTLE_MS: Number(T.highlightScanThrottleMs) || 150,
    TICK_MS: Number(T.highlightTickMs) || 1000,
    REPORT_MS: Number(T.highlightReportMs) || 400,
  };

  // 四种标记：未互关（重点）/ 互关 / 白名单 / 已取关
  const HL_KINDS = {
    nonMutual: { cls: "xuf-nonmutual", label: "未互关" },
    mutual: { cls: "xuf-mutual", label: "互关" },
    whitelisted: { cls: "xuf-whitelist", label: "白名单" },
    done: { cls: "xuf-unfollowed", label: "已取关" },
  };
  const HL_CLASSES = Object.keys(HL_KINDS).map((k) => HL_KINDS[k].cls);

  const hl = {
    on: false,
    observer: null,
    tickTimer: null,
    scanTimer: null,
    reportTimer: null,
    lastReport: 0,
    seen: new Map(), // handle(小写) -> kind
  };

  // 页面内样式。两条关键约定：
  //  1) 标记（底色 / 左侧色条 / 描边）一律画在 ::before 覆盖层上，**不改 cell 的 background-color**：
  //     X 在鼠标滑过时会重画整行底色（可能改 background-color，也可能由内部容器铺底），
  //     直接改 cell 背景会被它盖掉，表现为「滑过就变灰」；覆盖层绘制在内容之上
  //     （z-index:1 + pointer-events:none，不挡点击），因此滑过时标记颜色保持不变；
  //  2) 徽标走 ::after + attr(data-xuf-tag)，不插入子节点。
  const HL_CSS = [
    '[data-testid="UserCell"][data-xuf-tag]{position:relative}',
    '[data-testid="UserCell"][data-xuf-tag]::before{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;border-radius:12px;background:var(--xuf-bg,transparent);box-shadow:inset 3px 0 0 0 var(--xuf-bar,transparent)}',
    '[data-testid="UserCell"][data-xuf-tag]:hover::before{background:var(--xuf-bg-hover,var(--xuf-bg,transparent))}',
    // 徽标尺寸刻意压到 14px 高并贴顶 2px：X 的 UserCell 里按钮是垂直居中的，
    // 顶部只留得下 ~16px，这样徽标不会压到「正在关注」按钮（且 pointer-events:none 兜底）
    '[data-testid="UserCell"][data-xuf-tag]::after{content:attr(data-xuf-tag);position:absolute;top:2px;right:10px;z-index:3;height:14px;line-height:14px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:700;color:#fff;background:var(--xuf-tag-bg,#71767b);pointer-events:none;font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    // 未互关：整行淡红 + 左侧红条 + 细描边；滑过时红色略加深（而不是变灰）
    '[data-testid="UserCell"].xuf-nonmutual{--xuf-tag-bg:#f4212e;--xuf-bg:rgba(244,33,46,.10);--xuf-bg-hover:rgba(244,33,46,.18);--xuf-bar:#f4212e}',
    '[data-testid="UserCell"].xuf-nonmutual::before{outline:1px solid rgba(244,33,46,.5);outline-offset:-1px}',
    // 互关 / 白名单 / 已取关：只给左侧色条（同样画在覆盖层上，滑过不会丢）
    '[data-testid="UserCell"].xuf-mutual{--xuf-tag-bg:#00ba7c;--xuf-bar:rgba(0,186,124,.75)}',
    '[data-testid="UserCell"].xuf-whitelist{--xuf-tag-bg:#1d9bf0;--xuf-bar:rgba(29,155,240,.75)}',
    '[data-testid="UserCell"].xuf-unfollowed{--xuf-tag-bg:#71767b;--xuf-bar:rgba(113,118,123,.9);opacity:.5}',
  ].join("\n");

  function injectHighlightStyle() {
    if (document.getElementById(HL.STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HL.STYLE_ID;
    style.textContent = HL_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /** 该 cell 是否已经不在「正在关注」状态（用户已手动取关 / 自动取关） */
  function isNotFollowing(cell) {
    if (cell.querySelector(SEL.FOLLOW_BTN)) return true;
    return !!findButtonByText(cell, TEXT.follow);
  }

  /** 判定一个 cell 应打的标记 */
  function hlKindOf(cell, handle, followsYou) {
    if (isNotFollowing(cell)) return "done";
    if (whitelistSet.has(String(handle).toLowerCase())) return "whitelisted";
    return followsYou ? "mutual" : "nonMutual";
  }

  function hlApplyMark(cell, kind) {
    const meta = HL_KINDS[kind];
    for (const cls of HL_CLASSES) cell.classList.toggle(cls, cls === meta.cls);
    cell.setAttribute(HL.TAG_ATTR, meta.label);
    cell.setAttribute(HL.MARK_ATTR, kind);
  }

  function hlClearMarks() {
    for (const cell of document.querySelectorAll(`[${HL.TAG_ATTR}]`)) {
      for (const cls of HL_CLASSES) cell.classList.remove(cls);
      cell.removeAttribute(HL.TAG_ATTR);
      cell.removeAttribute(HL.MARK_ATTR);
      cell.removeAttribute(HL.SIG_ATTR);
    }
  }

  function hlCounts() {
    const c = { nonMutual: 0, mutual: 0, whitelisted: 0, done: 0 };
    for (const v of hl.seen.values()) if (c[v] != null) c[v]++;
    return c;
  }

  function hlSnapshot() {
    return { on: hl.on, ...hlCounts(), seen: hl.seen.size };
  }

  function hlFlushReport() {
    if (hl.reportTimer) {
      clearTimeout(hl.reportTimer);
      hl.reportTimer = null;
    }
    hl.lastReport = Date.now();
    send({ kind: "HIGHLIGHT", data: hlSnapshot() });
  }

  /** 上报节流：DOM 变动频繁时最多每 HL.REPORT_MS 报一次，并保证最后一次一定送达 */
  function hlReport(force) {
    if (force) {
      hlFlushReport();
      return;
    }
    const wait = HL.REPORT_MS - (Date.now() - hl.lastReport);
    if (wait <= 0) {
      hlFlushReport();
      return;
    }
    if (!hl.reportTimer) {
      hl.reportTimer = setTimeout(() => {
        hl.reportTimer = null;
        hlFlushReport();
      }, wait);
    }
  }

  /** 扫描当前 DOM：打标 + 累计计数（虚拟滚动下会被反复调用，必须幂等） */
  function hlScan() {
    if (!hl.on) return;
    if (!isFollowingPage()) {
      hlClearMarks();
      return;
    }

    for (const cell of document.querySelectorAll(SEL.USER_CELL)) {
      const marked = cell.getAttribute(HL.MARK_ATTR);
      const btn = cell.querySelector(HL.BTN_SEL);
      // 关注状态只可能随按钮变化（rest_id 级 testid）；按钮没变就不必重做昂贵解析
      const sig = btn ? btn.getAttribute("data-testid") || "" : "";
      if (marked && sig && cell.getAttribute(HL.SIG_ATTR) === sig) continue;

      const info = parseCell(cell);
      if (!info.handle) continue;
      const kind = hlKindOf(cell, info.handle, info.followsYou);
      if (marked !== kind) hlApplyMark(cell, kind);
      cell.setAttribute(HL.SIG_ATTR, sig);
      const key = info.handle.toLowerCase();
      if (hl.seen.get(key) !== kind) hl.seen.set(key, kind);
    }
    hlReport(false);
  }

  function hlScheduleScan() {
    if (!hl.on || hl.scanTimer) return;
    hl.scanTimer = setTimeout(() => {
      hl.scanTimer = null;
      hlScan();
    }, HL.SCAN_THROTTLE_MS);
  }

  function hlObserve() {
    if (hl.observer) return;
    try {
      hl.observer = new MutationObserver(hlScheduleScan);
      hl.observer.observe(document.body, { childList: true, subtree: true });
    } catch (_) {
      hl.observer = null; // 环境不支持时靠定时兜底
    }
  }

  /** 定时兜底：节点被复用/样式被重排时把标记补回去；离开目标页面则清标记 */
  function hlTick() {
    if (!hl.on) return;
    if (!isFollowingPage()) {
      hlClearMarks();
      return;
    }
    hlScan();
  }

  /** 开启标记；重复调用是幂等的（会做一次全量重扫，用于白名单变更后刷新） */
  function hlStart(rawConfig) {
    if (rawConfig) applyConfig(rawConfig);

    if (!isFollowingPage()) {
      log("当前不是“正在关注”页面，无法开启标记", "err");
      return false;
    }

    injectHighlightStyle();

    if (hl.on) {
      hlClearMarks();
      hlScan();
      hlReport(true);
      return true;
    }

    hl.on = true;
    hl.seen.clear();
    hl.lastReport = 0;
    hlScan();
    hlObserve();
    hl.tickTimer = setInterval(hlTick, HL.TICK_MS);
    hlReport(true);
    log("已开启「未互关」标记：标红的用户没有回关你，手动点取关即可", "ok");
    return true;
  }

  function hlStop() {
    if (!hl.on) {
      hlClearMarks();
      return false;
    }
    hl.on = false;
    if (hl.observer) {
      hl.observer.disconnect();
      hl.observer = null;
    }
    if (hl.tickTimer) {
      clearInterval(hl.tickTimer);
      hl.tickTimer = null;
    }
    if (hl.scanTimer) {
      clearTimeout(hl.scanTimer);
      hl.scanTimer = null;
    }
    hlClearMarks();
    hl.seen.clear();
    hlFlushReport();
    log("已关闭「未互关」标记", "warn");
    return true;
  }

  // ================================================================ 生命周期
  function resetRun() {
    state.stopRequested = false;
    state.scanned = 0;
    state.unfollowed = 0;
    state.skippedWhitelist = 0;
    state.skippedMutual = 0;
    state.failed = 0;
    state.consecutiveErrors = 0;
    state.currentHandle = null;
    scannedHandles.clear();
    document.querySelectorAll("[data-xuf-processed]").forEach((n) => {
      delete n.dataset.xufProcessed;
    });
  }

  function applyConfig(raw) {
    const c = raw || {};
    config.protectMutual = c.protectMutual !== false;
    config.dryRun = !!c.dryRun;
    const rawMin = Number(c.delayMin);
    const rawMax = Number(c.delayMax);
    const dMin = Number.isFinite(rawMin) ? Math.max(0, rawMin) : DEFAULT_CONFIG.delayMin;
    const dMax = Number.isFinite(rawMax) ? Math.max(dMin, rawMax) : DEFAULT_CONFIG.delayMax;
    config.delayMin = dMin;
    config.delayMax = dMax;
    config.maxUnfollow = Math.max(1, parseInt(c.maxUnfollow, 10) || DEFAULT_CONFIG.maxUnfollow);
    config.whitelist = Array.isArray(c.whitelist) ? c.whitelist.map((s) => String(s).toLowerCase()) : [];

    whitelistSet = new Set(config.whitelist);

    state.maxUnfollow = config.maxUnfollow;
    state.dryRun = config.dryRun;
  }

  async function startRun(rawConfig) {
    if (state.running) {
      log("任务已在运行中，忽略重复启动", "warn");
      return;
    }
    applyConfig(rawConfig);
    resetRun();

    if (!isFollowingPage()) {
      log("当前不是“正在关注”页面，已终止", "err");
      send({ kind: "ERROR", data: { message: "当前不是“正在关注”页面" } });
      send({ kind: "FINISH", data: snapshot() });
      return;
    }

    state.running = true;
    emitState("运行中");

    try {
      await mainLoop();
    } catch (err) {
      log(`运行异常：${err.message}`, "err");
      send({ kind: "ERROR", data: { message: err.message } });
    } finally {
      state.running = false;
      state.currentHandle = null;
      state.status = state.stopRequested ? "已停止" : "已结束";
      emitState();
      send({ kind: "FINISH", data: snapshot() });
    }
  }

  function requestStop() {
    if (!state.running) return;
    state.stopRequested = true;
    log("收到停止指令，正在中断…", "warn");
    emitState("停止中");
  }

  // ================================================================ 消息
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== "content") return;

    switch (msg.type) {
      case "START":
        startRun(msg.config); // 不阻塞，异步执行
        sendResponse({ ok: true, state: snapshot() });
        return;
      case "STOP":
        requestStop();
        sendResponse({ ok: true, state: snapshot() });
        return;
      case "GET_STATE":
        sendResponse({ ok: true, state: snapshot() });
        return;
      case "PING":
        sendResponse({ ok: true, onFollowingPage: isFollowingPage(), highlight: hlSnapshot() });
        return;
      case "HIGHLIGHT_START": {
        const ok = hlStart(msg.config);
        sendResponse({
          ok,
          error: ok ? undefined : "当前不是“正在关注”页面",
          state: snapshot(),
        });
        return;
      }
      case "HIGHLIGHT_STOP":
        hlStop();
        sendResponse({ ok: true, state: snapshot() });
        return;
      case "CS_FOLLOW_PROFILE": {
        // 关注作者主页（异步）→ 必须返回 true 保持消息通道开启
        followProfileOnPage(msg.handle)
          .then((outcome) => sendResponse({ ok: true, outcome }))
          .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
        return true;
      }
      default:
        sendResponse({ ok: false, error: "未知指令：" + msg.type });
    }
  });

  // 首次注入时上报一次环境
  send({ kind: "READY", data: { url: location.href, onFollowingPage: isFollowingPage() } });
})();

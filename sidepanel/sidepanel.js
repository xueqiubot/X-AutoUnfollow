/* ==========================================================================
   sidepanel.js — 侧边栏交互逻辑、状态同步与控制
   通信链路：Side Panel --(chrome.runtime.sendMessage)--> Service Worker
             --(chrome.tabs.sendMessage)--> Content Script
   反向：Content Script --(chrome.runtime.sendMessage)--> SW 广播 { to: "panel" } --> 侧边栏
   ========================================================================== */
(() => {
  "use strict";

  const STORAGE_KEY = "xuf_config";
  const AUTHOR_CARD_KEY = "xuf_author_card";
  const FOLLOWING_RE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/following(?:[/?#].*)?$/i;

  const DEFAULT_CONFIG = {
    whitelist: [],
    protectMutual: true,
    delayMin: 5000,
    delayMax: 10000,
    maxUnfollow: 50,
    dryRun: false,
  };

  /**
   * 作者卡片配置。
   *  - `followed` 默认为 false；关注成功（followed / already）时置 true 落盘，
   *    之后卡片永久隐藏（除非手动重置）。
   *  - 底部小字的关闭只影响本次会话，不写 storage。
   */
  const DEFAULT_AUTHOR_CARD = {
    enabled: true,
    handle: "4ndee",
    displayName: "还在折腾",
    tagline: "作者主页 · 欢迎持续关注获取更多内容…",
    followed: false,
  };

  // ------------------------------------------------------------------ DOM
  const $ = (id) => document.getElementById(id);
  const el = {
    envBadge: $("envBadge"),
    envText: $("envText"),
    btnStart: $("btnStart"),
    btnStop: $("btnStop"),
    dryRun: $("dryRun"),
    statStatus: $("statStatus"),
    statScanned: $("statScanned"),
    statUnfollowed: $("statUnfollowed"),
    statWhite: $("statWhite"),
    statMutual: $("statMutual"),
    statFailed: $("statFailed"),
    progressBar: $("progressBar"),
    progressText: $("progressText"),
    currentHandle: $("currentHandle"),
    logBox: $("logBox"),
    protectMutual: $("protectMutual"),
    whitelistInput: $("whitelistInput"),
    tagList: $("tagList"),
    whiteCount: $("whiteCount"),
    btnClearWhite: $("btnClearWhite"),
    delayMin: $("delayMin"),
    delayMax: $("delayMax"),
    delayMinVal: $("delayMinVal"),
    delayMaxVal: $("delayMaxVal"),
    delayLabel: $("delayLabel"),
    maxUnfollow: $("maxUnfollow"),
    // 作者卡片
    authorCard: $("authorCard"),
    acAvatar: $("acAvatar"),
    acName: $("acName"),
    acLink: $("acLink"),
    acTagline: $("acTagline"),
    acFollow: $("acFollow"),
    acFollowText: $("acFollowText"),
    acDismiss: $("acDismiss"),
    toast: $("toast"),
  };

  // --------------------------------------------------------------- State
  let config = { ...DEFAULT_CONFIG };
  let authorCard = { ...DEFAULT_AUTHOR_CARD };
  let acPhase = "idle"; // idle | following | done
  let acSessionClosed = false; // 本次会话内已点小字关闭（不落盘）
  let running = false;
  let envOk = false;
  let currentTabId = null;
  let watchdog = null;
  const MAX_LOG_LINES = 200;

  // =============================================================== 持久化
  async function loadConfig() {
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      config = sanitizeConfig({ ...DEFAULT_CONFIG, ...(raw[STORAGE_KEY] || {}) });
    } catch (e) {
      console.warn("[XUF] 读取配置失败", e);
      config = { ...DEFAULT_CONFIG };
    }
    applyConfigToUI();
  }

  async function saveConfig() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: config });
    } catch (e) {
      console.warn("[XUF] 保存配置失败", e);
    }
  }

  function sanitizeConfig(c) {
    const wl = Array.isArray(c.whitelist)
      ? [...new Set(c.whitelist.map(normalizeHandle).filter(Boolean))]
      : [];
    let dMin = clampInt(c.delayMin, 1, 120, DEFAULT_CONFIG.delayMin);
    let dMax = clampInt(c.delayMax, 1, 300, DEFAULT_CONFIG.delayMax);
    if (dMin > dMax) dMax = dMin;
    return {
      whitelist: wl,
      protectMutual: !!c.protectMutual,
      delayMin: dMin,
      delayMax: dMax,
      maxUnfollow: clampInt(c.maxUnfollow, 1, 5000, DEFAULT_CONFIG.maxUnfollow),
      dryRun: !!c.dryRun,
    };
  }

  function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeHandle(s) {
    return String(s || "").trim().replace(/^@+/, "").toLowerCase();
  }

  // ============================================================ 配置 -> UI
  function applyConfigToUI() {
    el.protectMutual.checked = config.protectMutual;
    el.dryRun.checked = config.dryRun;
    el.delayMin.value = String(Math.round(config.delayMin / 1000));
    el.delayMax.value = String(Math.round(config.delayMax / 1000));
    el.maxUnfollow.value = String(config.maxUnfollow);
    renderWhitelist();
    updateDelayLabel();
  }

  function updateDelayLabel() {
    const a = Math.round(config.delayMin / 1000);
    const b = Math.round(config.delayMax / 1000);
    el.delayMinVal.textContent = `${a}s`;
    el.delayMaxVal.textContent = `${b}s`;
    el.delayLabel.textContent = `${a} – ${b} 秒`;
  }

  function renderWhitelist() {
    el.tagList.textContent = "";
    for (const h of config.whitelist) {
      const tag = document.createElement("span");
      tag.className = "tag";
      const txt = document.createElement("span");
      txt.textContent = "@" + h;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "✕";
      btn.title = "移除";
      btn.addEventListener("click", () => {
        config.whitelist = config.whitelist.filter((x) => x !== h);
        renderWhitelist();
        saveConfig();
      });
      tag.append(txt, btn);
      el.tagList.appendChild(tag);
    }
    el.whiteCount.textContent = `共 ${config.whitelist.length} 个`;
  }

  // ============================================================== 环境检测
  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) return tab;
    // 侧边栏某些情况下 currentWindow 取不到，退回最后聚焦窗口
    const [t2] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t2 || null;
  }

  async function refreshEnv() {
    const tab = await getActiveTab();
    currentTabId = tab?.id ?? null;
    envOk = !!(tab?.url && FOLLOWING_RE.test(tab.url));

    el.envBadge.classList.remove("env-ok", "env-bad", "env-unknown");
    if (!tab?.id) {
      el.envBadge.classList.add("env-bad");
      el.envText.textContent = "未找到活动标签页";
    } else if (!tab.url || !/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(tab.url)) {
      el.envBadge.classList.add("env-bad");
      el.envText.textContent = "请先前往 X 的“正在关注”页面";
    } else if (!envOk) {
      el.envBadge.classList.add("env-bad");
      el.envText.textContent = "当前不是“正在关注”页面";
    } else {
      el.envBadge.classList.add("env-ok");
      el.envText.textContent = "已就绪：正在关注页面";
    }

    syncButtons();
  }

  function syncButtons() {
    el.btnStart.disabled = running || !envOk;
    el.btnStop.disabled = !running;
    // 运行时锁定配置，避免中途改动导致上下游口径不一致
    el.protectMutual.disabled = running;
    el.delayMin.disabled = running;
    el.delayMax.disabled = running;
    el.maxUnfollow.disabled = running;
    el.whitelistInput.disabled = running;
    el.btnClearWhite.disabled = running;
  }

  // ============================================================== 作者卡片
  // 与 x-自动运营 的 ProfileCard 同逻辑：
  //   - 顶部卡片，展示头像 / 显示名 / 一行简介 + 「关注」快捷按钮 + 外链主页；
  //   - 点「关注」→ 交给 Service Worker 打开作者主页并自动关注；
  //     结果为 followed / already 即视为已关注：立即隐藏 + 落盘（唯一永久隐藏路径）；
  //     结果为 unavailable / failed 则保留卡片并提示，可重试；
  //   - 点底部小字 → 仅本次会话内隐藏（纯 UI state，不落盘，重开恢复）。
  // 存储独立成 key，避免与 xuf_config 的 sanitize 逻辑互相干扰。

  async function loadAuthorCard() {
    try {
      const raw = await chrome.storage.local.get(AUTHOR_CARD_KEY);
      const saved = raw[AUTHOR_CARD_KEY] || {};
      authorCard = { ...DEFAULT_AUTHOR_CARD, ...saved };
    } catch (e) {
      console.warn("[XUF] 读取作者卡片失败", e);
      authorCard = { ...DEFAULT_AUTHOR_CARD };
    }
    renderAuthorCard();
  }

  async function saveAuthorCard(patch) {
    authorCard = { ...authorCard, ...patch };
    try {
      await chrome.storage.local.set({ [AUTHOR_CARD_KEY]: authorCard });
    } catch (e) {
      console.warn("[XUF] 保存作者卡片失败", e);
    }
  }

  function profileUrl(handle) {
    return `https://x.com/${String(handle || "").replace(/^@/, "").trim()}`;
  }

  /** 已隐藏（本地即时 / 持久化任一为真）则完全不渲染 */
  function renderAuthorCard() {
    const handle = String(authorCard.handle || "").replace(/^@/, "").trim();
    const hidden =
      acSessionClosed || authorCard.followed || !authorCard.enabled || !handle;

    if (hidden) {
      el.authorCard.hidden = true;
      return;
    }

    const displayName = String(authorCard.displayName || "").trim() || `@${handle}`;
    el.acName.textContent = displayName;
    el.acTagline.textContent = authorCard.tagline || `@${handle}`;
    el.acAvatar.alt = displayName;

    const url = profileUrl(handle);
    el.acLink.href = url;
    el.acLink.title = `打开 ${url}`;
    el.acFollow.title = `关注 @${handle}`;

    setFollowButton(acPhase);
    el.authorCard.hidden = false;
  }

  function setFollowButton(phase) {
    acPhase = phase;
    const busy = phase === "following";
    const done = phase === "done";
    el.acFollow.disabled = busy || done;
    el.acFollow.classList.toggle("is-done", done);
    el.acFollow.querySelector(".ac-follow-ico").textContent = done ? "✓" : busy ? "" : "＋";
    el.acFollowText.textContent = busy ? "关注中…" : done ? "已关注" : "关注";
  }

  async function followAuthor() {
    const handle = String(authorCard.handle || "").replace(/^@/, "").trim();
    if (!handle) {
      toast("未配置作者 handle", "danger");
      return;
    }
    setFollowButton("following");
    try {
      const res = await chrome.runtime.sendMessage({
        to: "background",
        kind: "PROFILE_FOLLOW",
        handle,
      });

      const outcome = res && res.ok ? res.data && res.data.outcome : null;
      if (!res || !res.ok) {
        toast((res && res.error) || "关注失败，请稍后重试", "danger");
        setFollowButton("idle");
        return;
      }

      switch (outcome) {
        case "followed":
          toast(`已关注 @${handle}`, "ok");
          break;
        case "already":
          toast("已经关注过了", "ok");
          break;
        case "unavailable":
          toast("未找到关注入口，请确认已登录 X", "danger");
          setFollowButton("idle");
          return;
        default:
          toast("关注失败，可能被风控拦截", "danger");
          setFollowButton("idle");
          return;
      }

      // followed / already → 视为已关注：立即隐藏 + 落盘
      setFollowButton("done");
      await saveAuthorCard({ followed: true });
      el.authorCard.hidden = true;
    } catch (err) {
      toast(String((err && err.message) || err), "danger");
      setFollowButton("idle");
    }
  }

  /**
   * 点击底部小字：仅本次会话内隐藏。
   * 刻意**不写 storage** —— 用户要求「下次打开依旧出现」。
   * 真正永久的隐藏只有一条路径：点「关注」成功。
   */
  function dismissAuthorCard() {
    acSessionClosed = true;
    renderAuthorCard();
  }

  // ================================================================ Toast
  let toastTimer = null;
  function toast(msg, tone = "") {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.className = "toast" + (tone ? " " + tone : "");
    el.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  // ================================================================ 日志
  function appendLog(line, level = "") {
    const now = new Date();
    const t = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    const div = document.createElement("div");
    div.className = "ln" + (level ? " " + level : "");
    const ts = document.createElement("span");
    ts.className = "t";
    ts.textContent = t;
    const msg = document.createElement("span");
    msg.textContent = line;
    div.append(ts, msg);
    el.logBox.appendChild(div);
    while (el.logBox.childElementCount > MAX_LOG_LINES) {
      el.logBox.removeChild(el.logBox.firstElementChild);
    }
    el.logBox.scrollTop = el.logBox.scrollHeight;
  }

  function setStatus(text) {
    el.statStatus.textContent = text;
  }

  // ========================================================== 状态渲染
  function renderStats(s) {
    if (!s) return;
    el.statScanned.textContent = fmt(s.scanned);
    el.statUnfollowed.textContent = fmt(s.unfollowed);
    el.statWhite.textContent = fmt(s.skippedWhitelist);
    el.statMutual.textContent = fmt(s.skippedMutual);
    el.statFailed.textContent = fmt(s.failed);

    const total = s.scanned || 0;
    const done = s.unfollowed || 0;
    const limit = s.maxUnfollow || config.maxUnfollow || 0;
    const pct = limit > 0 ? Math.min(100, (done / limit) * 100) : 0;
    el.progressBar.style.width = pct.toFixed(1) + "%";
    el.progressText.textContent = `${done} / ${limit}` + (total ? `（已扫描 ${total}）` : "");

    el.currentHandle.textContent = s.currentHandle ? "当前 @" + s.currentHandle : "";
  }

  function fmt(n) {
    return Number.isFinite(n) ? String(n) : "0";
  }

  // ============================================================ 消息总线
  function sendToContent(payload) {
    return new Promise((resolve) => {
      if (typeof currentTabId !== "number") {
        resolve({ ok: false, error: "未找到活动标签页" });
        return;
      }
      chrome.runtime.sendMessage(
        { to: "background", kind: "FORWARD", tabId: currentTabId, payload },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "无响应" });
          }
        }
      );
    });
  }

  // 接收来自 Service Worker 的广播（content script 上报）
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.to !== "panel") return;
    handlePanelMessage(msg);
  });

  function handlePanelMessage(msg) {
    switch (msg.kind) {
      case "STATE":
        renderStats(msg.data);
        if (msg.data?.status) setStatus(msg.data.status);
        break;
      case "LOG":
        appendLog(msg.data?.message || "", msg.data?.level || "");
        break;
      case "FINISH":
        running = false;
        setStatus("已结束");
        renderStats(msg.data);
        appendLog(
          `任务结束：取关 ${msg.data?.unfollowed ?? 0}，跳过白名单 ${msg.data?.skippedWhitelist ?? 0}，跳过互关 ${msg.data?.skippedMutual ?? 0}，失败 ${msg.data?.failed ?? 0}`,
          "ok"
        );
        stopWatchdog();
        syncButtons();
        break;
      case "ERROR":
        appendLog(msg.data?.message || "未知错误", "err");
        break;
      default:
        break;
    }
  }

  // =============================================================== 看门狗
  // 内容脚本因页面刷新/跳转而失联时，靠轮询把侧边栏从「运行中」状态里拉出来
  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(async () => {
      const resp = await sendToContent({ type: "GET_STATE" });
      if (!resp.ok) {
        running = false;
        setStatus("已中断");
        appendLog("与页面脚本失联（可能页面已刷新或跳转）", "err");
        stopWatchdog();
        syncButtons();
      }
    }, 2000);
  }

  function stopWatchdog() {
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }

  // =============================================================== 交互
  el.btnStart.addEventListener("click", async () => {
    await refreshEnv();
    if (!envOk) {
      appendLog("请先在浏览器中打开 X 的“正在关注”页面", "warn");
      return;
    }
    await saveConfig();

    running = true;
    setStatus("启动中");
    el.logBox.textContent = "";
    appendLog(
      config.dryRun
        ? "启动演练模式（不会真正取关）"
        : "启动自动取关任务",
      "ok"
    );
    syncButtons();

    const resp = await sendToContent({ type: "START", config });
    if (!resp.ok) {
      running = false;
      setStatus("启动失败");
      appendLog(resp.error || "启动失败", "err");
      syncButtons();
      return;
    }
    setStatus("运行中");
    startWatchdog();
  });

  el.btnStop.addEventListener("click", async () => {
    setStatus("正在停止…");
    el.btnStop.disabled = true;
    const resp = await sendToContent({ type: "STOP" });
    if (!resp.ok) appendLog(resp.error || "停止指令发送失败", "err");
    else appendLog("已发送停止指令", "warn");
  });

  // ---- 互关保护 ----
  el.protectMutual.addEventListener("change", () => {
    config.protectMutual = el.protectMutual.checked;
    saveConfig();
  });

  // ---- 作者卡片：关注 / 本次关闭 ----
  el.acFollow.addEventListener("click", () => {
    if (acPhase === "following" || acPhase === "done") return;
    void followAuthor();
  });
  el.acDismiss.addEventListener("click", dismissAuthorCard);

  // ---- 演练模式 ----
  el.dryRun.addEventListener("change", () => {
    config.dryRun = el.dryRun.checked;
    saveConfig();
  });

  // ---- 白名单输入 ----
  function addWhitelistFromInput() {
    const raw = el.whitelistInput.value;
    if (!raw) return;
    // 支持逗号 / 空格 / 换行分隔的批量粘贴
    const parts = raw.split(/[\s,，;；]+/).map(normalizeHandle).filter(Boolean);
    if (!parts.length) return;
    const set = new Set(config.whitelist);
    let added = 0;
    const invalid = [];
    for (const p of parts) {
      if (!/^[a-z0-9_]{1,15}$/.test(p)) {
        invalid.push(p);
        continue;
      }
      if (!set.has(p)) {
        set.add(p);
        added++;
      }
    }
    config.whitelist = [...set];
    el.whitelistInput.value = "";
    renderWhitelist();
    saveConfig();
    if (added) appendLog(`白名单新增 ${added} 个账号`, "ok");
    if (invalid.length) appendLog(`已忽略无效账号：${invalid.join(", ")}`, "warn");
  }

  el.whitelistInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === "，") {
      e.preventDefault();
      addWhitelistFromInput();
    } else if (e.key === "Backspace" && !el.whitelistInput.value && config.whitelist.length) {
      config.whitelist.pop();
      renderWhitelist();
      saveConfig();
    }
  });
  el.whitelistInput.addEventListener("blur", addWhitelistFromInput);

  el.btnClearWhite.addEventListener("click", () => {
    if (!config.whitelist.length) return;
    config.whitelist = [];
    renderWhitelist();
    saveConfig();
    appendLog("白名单已清空", "warn");
  });

  // ---- 延迟滑块 ----
  function onDelayChange() {
    let dMin = clampInt(el.delayMin.value, 1, 120, 5) * 1000;
    let dMax = clampInt(el.delayMax.value, 1, 300, 10) * 1000;
    if (dMin > dMax) {
      // 谁被拖动就迁就谁
      if (document.activeElement === el.delayMin) dMax = dMin;
      else dMin = dMax;
    }
    config.delayMin = dMin;
    config.delayMax = dMax;
    el.delayMin.value = String(Math.round(dMin / 1000));
    el.delayMax.value = String(Math.round(dMax / 1000));
    updateDelayLabel();
    saveConfig();
  }
  el.delayMin.addEventListener("input", onDelayChange);
  el.delayMax.addEventListener("input", onDelayChange);

  // ---- 上限 ----
  el.maxUnfollow.addEventListener("change", () => {
    config.maxUnfollow = clampInt(el.maxUnfollow.value, 1, 5000, 50);
    el.maxUnfollow.value = String(config.maxUnfollow);
    if (!running) renderStats({ scanned: 0, unfollowed: 0, skippedWhitelist: 0, skippedMutual: 0, failed: 0, maxUnfollow: config.maxUnfollow });
    saveConfig();
  });

  // ========================================================== 环境跟随
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab?.active && (info.status === "complete" || info.url)) refreshEnv();
  });
  chrome.tabs.onActivated.addListener(() => refreshEnv());
  if (chrome.windows?.onFocusChanged) {
    chrome.windows.onFocusChanged.addListener(() => refreshEnv());
  }

  // ================================================================ 启动
  (async function init() {
    await loadConfig();
    await loadAuthorCard();
    renderStats({ scanned: 0, unfollowed: 0, skippedWhitelist: 0, skippedMutual: 0, failed: 0, maxUnfollow: config.maxUnfollow });
    await refreshEnv();
    appendLog("面板已就绪");
  })();
})();

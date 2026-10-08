/**
 * background.js — Service Worker
 *
 * 职责：
 *  1. 生命周期：安装时设置「点击扩展图标即打开侧边栏」。
 *  2. 消息总线：Side Panel ↔ Service Worker ↔ Content Script 三方中转。
 *     - Side Panel  -> { to: "background", kind: "FORWARD", tabId, payload }  -> 转发给目标标签页的 content script
 *     - Content     -> { to: "background", from: "content", ... }             -> 改写为 { to: "panel" } 广播给侧边栏
 *
 * 说明：Service Worker 不会收到自己 via chrome.runtime.sendMessage 发出的消息，
 *      因此「广播给侧边栏」不会形成回环。
 */

// ---------------------------------------------------------------------------
// 1. 生命周期：让点击工具栏图标直接唤起侧边栏
// ---------------------------------------------------------------------------
function enableActionClickToOpen() {
  // Chrome 116+ 支持 openPanelOnActionClick
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[XUF] setPanelBehavior 失败:", err));
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionClickToOpen();
});

chrome.runtime.onStartup.addListener(() => {
  enableActionClickToOpen();
});

// Service Worker 冷启动时也补一次，保证行为一致
enableActionClickToOpen();

// ---------------------------------------------------------------------------
// 2. 消息总线
// ---------------------------------------------------------------------------
const VALID_KINDS = new Set(["FORWARD", "STATE", "LOG", "FINISH", "READY", "ERROR"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  // ---- 来自侧边栏：转发到目标标签页的 content script ----
  if (msg.to === "background") {
    // 2a. 内容脚本上报事件 -> 广播给侧边栏
    if (msg.from === "content") {
      if (!VALID_KINDS.has(msg.kind)) return;
      broadcastToPanel({
        to: "panel",
        kind: msg.kind,
        tabId: sender?.tab?.id ?? null,
        data: msg.data ?? null,
        ts: Date.now(),
      });
      return;
    }

    // 2b. 侧边栏下发指令 -> 转发到指定 tab 的 content script
    if (msg.kind === "FORWARD") {
      const tabId = msg.tabId;
      const payload = msg.payload || {};
      if (typeof tabId !== "number") {
        sendResponse({ ok: false, error: "缺少有效的 tabId" });
        return true;
      }

      deliverToContent(tabId, payload)
        .then((res) => sendResponse({ ok: true, data: res }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // 异步响应
    }

    // 2c. 侧边栏「作者卡片」请求关注 -> SW 直接编排
    //     （查/建标签页 -> 等就绪 -> 确保 content script 注入 -> 下发 CS_FOLLOW_PROFILE）
    //     逻辑与复用点同 x-自动运营 的 followProfile()，不另起一套标签页/消息通道。
    if (msg.kind === "PROFILE_FOLLOW") {
      followProfile(msg.handle)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // 异步响应
    }
  }
});

/** 向指定标签页投递消息；若 content script 尚未注入则用 scripting 兜底注入后重试一次 */
async function deliverToContent(tabId, payload) {
  const message = { to: "content", ...payload };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // 常见于：页面是 SPA、脚本刚被刷新卸载，或扩展刚装上而页面未刷新
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/content-script.js"],
      });
      await new Promise((r) => setTimeout(r, 120));
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err2) {
      throw new Error(
        "无法与页面脚本通信，请确认当前标签页已打开 x.com 并刷新一次。（" +
          (err2?.message || err2) +
          "）"
      );
    }
  }
}

/** 广播给侧边栏（侧边栏通过 chrome.runtime.onMessage 接收） */
function broadcastToPanel(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    /* 侧边栏未打开时静默忽略 */
  });
}

// ---------------------------------------------------------------------------
// 2d. 作者主页关注（侧边栏「作者卡片」）
// ---------------------------------------------------------------------------

/** 主页是 SPA：切到 x.com/<handle> 后 DOM 需要重渲染，对 unavailable 做有限重试 */
const PROFILE_FOLLOW_ATTEMPTS = 5;
const TAB_READY_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function profileUrl(handle) {
  return `https://x.com/${String(handle || "").replace(/^@/, "").trim()}`;
}

/** 轮询等待标签页 status 变为 complete（带超时，避免永久挂起） */
async function waitForTabReady(tabId, timeout = TAB_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === "complete") return true;
    } catch (_) {
      return false; // 标签页已关闭
    }
    await sleep(250);
  }
  return false;
}

/** content script 可能尚未注入（新标签页）→ 兜底注入一次 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { to: "content", type: "PING" });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/content-script.js"],
      });
      await sleep(120);
      await chrome.tabs.sendMessage(tabId, { to: "content", type: "PING" });
      return true;
    } catch (_) {
      return false;
    }
  }
}

/**
 * 打开目标作者主页并关注。
 *  1) 优先复用已打开在目标主页的标签页；否则复用任意 X 标签页并导航过去；都没有则新建；
 *  2) 等页面就绪 + 确保 content script 已注入；
 *  3) 下发 CS_FOLLOW_PROFILE，对「主页尚未渲染」（unavailable）做有限重试。
 *
 * @returns {Promise<{outcome: 'followed'|'already'|'unavailable'|'failed'}>}
 */
async function followProfile(handle) {
  const clean = String(handle || "").replace(/^@/, "").trim();
  if (!clean) throw new Error("未配置作者 handle");

  const targetUrl = profileUrl(clean);
  const targetPath = `/${clean.toLowerCase()}`;

  // 1) 定位/创建标签页
  const tabs = await chrome.tabs.query({
    url: ["https://x.com/*", "https://twitter.com/*"],
  });
  let tabId = null;

  const onTarget = tabs.find((t) => {
    const u = (t.url || "").toLowerCase();
    return u.includes(`x.com${targetPath}`) || u.includes(`twitter.com${targetPath}`);
  });

  if (onTarget && onTarget.id != null) {
    tabId = onTarget.id;
    await chrome.tabs.update(tabId, { active: true });
  } else if (tabs[0] && tabs[0].id != null) {
    tabId = tabs[0].id;
    await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    await waitForTabReady(tabId);
  } else {
    const created = await chrome.tabs.create({ url: targetUrl, active: true });
    tabId = created.id != null ? created.id : null;
    if (tabId != null) await waitForTabReady(tabId);
  }

  if (tabId == null) throw new Error("无法打开作者主页标签页");

  // 2) 确保 content script 就绪
  const ready = await ensureContentScript(tabId);
  if (!ready) throw new Error("目标页面脚本未就绪，请稍后重试");

  // 3) 下发关注指令，对「主页尚未渲染」做有限重试
  for (let attempt = 0; attempt < PROFILE_FOLLOW_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, {
        to: "content",
        type: "CS_FOLLOW_PROFILE",
        handle: clean,
      });
    } catch (err) {
      throw new Error("无法与页面脚本通信，请确认当前标签页已打开 x.com 并刷新一次");
    }

    if (!res || !res.ok) {
      throw new Error((res && res.error) || "关注指令执行失败");
    }

    if (res.outcome === "unavailable") {
      await sleep(900);
      continue;
    }
    return { outcome: res.outcome };
  }

  throw new Error("目标主页未能就绪，请确认已登录 X 后重试");
}

// ---------------------------------------------------------------------------
// 3. 侧边栏打开时，若当前标签页是 X，主动提示内容脚本上报一次状态
// ---------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    await chrome.tabs.sendMessage(tabId, { to: "content", type: "PING" });
  } catch (_) {
    /* 非 X 页面，忽略 */
  }
});

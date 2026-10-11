/**
 * tools/test-sidepanel-highlight.cjs
 * 用 jsdom + chrome API 桩验证侧边栏「未互关标记」这条链路：
 *   - 环境就绪时按钮可用；点击 -> 下发 HIGHLIGHT_START / HIGHLIGHT_STOP
 *   - 内容脚本上报的 HIGHLIGHT 广播能渲染到计数
 *   - 开启状态落盘到 chrome.storage.local，重开侧边栏后自动补开
 *   - 非「正在关注」页面时按钮禁用、不误发指令
 *
 * 运行：
 *   NODE_PATH=<node workspace>/node_modules node tools/test-sidepanel-highlight.cjs
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.dirname(__dirname);
const HTML = fs.readFileSync(path.join(ROOT, "sidepanel", "index.html"), "utf8");
const SRC = fs.readFileSync(path.join(ROOT, "sidepanel", "sidepanel.js"), "utf8");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  \u2713 " + name);
  } else {
    fail++;
    failures.push(name + (extra ? " -> " + extra : ""));
    console.log("  \u2717 " + name + (extra ? " -> " + extra : ""));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 夹具
/**
 * 建一个侧边栏环境。
 * @param {object} opts
 * @param {string} opts.url          活动标签页 URL
 * @param {object} opts.storage      预置的 chrome.storage.local 内容
 * @param {object} opts.contentState 内容脚本当前的标记状态
 */
function makePanel({ url = "https://x.com/alice/following", storage = {}, contentState } = {}) {
  const store = { ...storage };
  const forwarded = []; // 侧边栏下发给内容脚本的 payload
  const listeners = [];
  let state = contentState || { on: false, nonMutual: 0, mutual: 0, whitelisted: 0, done: 0 };

  const dom = new JSDOM(HTML, {
    url: "chrome-extension://test/sidepanel/index.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.chrome = {
        storage: {
          local: {
            get: async (key) => ({ [key]: store[key] }),
            set: async (obj) => Object.assign(store, obj),
          },
        },
        tabs: {
          query: async () => [{ id: 7, url, active: true }],
          onUpdated: { addListener() {} },
          onActivated: { addListener() {} },
        },
        windows: { onFocusChanged: { addListener() {} } },
        runtime: {
          onMessage: { addListener: (fn) => listeners.push(fn) },
          lastError: undefined,
          sendMessage: (msg, cb) => {
            // 侧边栏 -> Service Worker -> 内容脚本（这里直接短路成桩）
            if (msg && msg.to === "background" && msg.kind === "FORWARD") {
              const payload = msg.payload || {};
              forwarded.push(payload);
              let data = { ok: true, state: {} };
              if (payload.type === "HIGHLIGHT_START") {
                state = { on: true, nonMutual: 3, mutual: 2, whitelisted: 1, done: 0 };
                data = { ok: true, state: { highlight: state } };
              } else if (payload.type === "HIGHLIGHT_STOP") {
                state = { on: false, nonMutual: 0, mutual: 0, whitelisted: 0, done: 0 };
                data = { ok: true, state: { highlight: state } };
              } else if (payload.type === "GET_STATE") {
                data = { ok: true, state: { highlight: state } };
              }
              if (cb) cb({ ok: true, data });
              return;
            }
            if (cb) cb({ ok: true, data: { outcome: "already" } });
          },
        },
      };
    },
  });

  dom.window.eval(SRC);

  return {
    dom,
    win: dom.window,
    doc: dom.window.document,
    store,
    forwarded,
    /** 模拟内容脚本上报 HIGHLIGHT 广播（经 SW 广播给侧边栏） */
    broadcast(data, tabId = 7) {
      for (const fn of listeners) fn({ to: "panel", kind: "HIGHLIGHT", tabId, data });
    },
    types: () => forwarded.map((p) => p.type),
    lastPayload: (type) => [...forwarded].reverse().find((p) => p.type === type),
    close: () => dom.window.close(),
  };
}

const $ = (p, id) => p.doc.getElementById(id);

// ================================================================ 用例
(async () => {
  console.log("\n=== 用例 1：环境就绪 -> 点击开启标记 ===");
  {
    const p = makePanel();
    await sleep(300);

    check("环境徽标显示已就绪", /已就绪/.test($(p, "envText").textContent), $(p, "envText").textContent);
    check("标记按钮可用", $(p, "btnHighlight").disabled === false);
    check("按钮初始文案为「标记未互关用户」", $(p, "btnHighlightText").textContent === "标记未互关用户");

    $(p, "btnHighlight").click();
    await sleep(600); // 等点击链路 + 环境防抖对齐（350ms）跑完，避免与后面的广播竞争

    check(
      "点击后下发 HIGHLIGHT_START",
      p.types().includes("HIGHLIGHT_START"),
      p.types().join(",")
    );
    const payload = p.lastPayload("HIGHLIGHT_START");
    check("下发时带上配置（含白名单字段）", payload && payload.config && Array.isArray(payload.config.whitelist), JSON.stringify(payload && payload.config));
    check("按钮切到「停止标记」", $(p, "btnHighlightText").textContent === "停止标记", $(p, "btnHighlightText").textContent);
    check("按钮进入 is-on 状态", $(p, "btnHighlight").classList.contains("is-on"));
    check("计数渲染：未互关 3", $(p, "hlNonMutual").textContent === "3", $(p, "hlNonMutual").textContent);
    check("计数渲染：互关 2 / 白名单 1", $(p, "hlMutual").textContent === "2" && $(p, "hlWhite").textContent === "1");
    check("开启状态已落盘", p.store.xuf_highlight && p.store.xuf_highlight.enabled === true, JSON.stringify(p.store.xuf_highlight));

    // 内容脚本后续上报（例如滚动出新用户）应实时刷新计数
    p.broadcast({ on: true, nonMutual: 9, mutual: 4, whitelisted: 1, done: 2 });
    await sleep(80);
    check("广播后计数刷新：未互关 9 / 已取关 2", $(p, "hlNonMutual").textContent === "9" && $(p, "hlDone").textContent === "2");

    // 再点一次 -> 关闭
    $(p, "btnHighlight").click();
    await sleep(300);
    check("再次点击下发 HIGHLIGHT_STOP", p.types().includes("HIGHLIGHT_STOP"), p.types().join(","));
    check("按钮恢复为「标记未互关用户」", $(p, "btnHighlightText").textContent === "标记未互关用户");
    check("关闭后计数归零", $(p, "hlNonMutual").textContent === "0" && $(p, "hlDone").textContent === "0");
    check("关闭状态已落盘", p.store.xuf_highlight && p.store.xuf_highlight.enabled === false);

    p.close();
  }

  console.log("\n=== 用例 2：上次开着标记 -> 重开侧边栏自动补开 ===");
  {
    // 内容脚本侧因为页面刷新已经丢了标记状态（on=false），但偏好仍为开启
    const p = makePanel({
      storage: { xuf_highlight: { enabled: true } },
      contentState: { on: false, nonMutual: 0, mutual: 0, whitelisted: 0, done: 0 },
    });
    await sleep(600); // 等 refreshEnv -> 防抖 -> 自动补开

    check(
      "自动补发 HIGHLIGHT_START",
      p.types().includes("HIGHLIGHT_START"),
      p.types().join(",")
    );
    check("按钮显示为已开启", $(p, "btnHighlightText").textContent === "停止标记", $(p, "btnHighlightText").textContent);
    check("计数按内容脚本返回渲染", $(p, "hlNonMutual").textContent === "3", $(p, "hlNonMutual").textContent);
    p.close();
  }

  console.log("\n=== 用例 3：内容脚本已开着标记 -> 只对齐状态，不重复下发 ===");
  {
    const p = makePanel({
      storage: { xuf_highlight: { enabled: true } },
      contentState: { on: true, nonMutual: 5, mutual: 1, whitelisted: 0, done: 0 },
    });
    await sleep(600);

    check("未重复下发 HIGHLIGHT_START", !p.types().includes("HIGHLIGHT_START"), p.types().join(","));
    check("按 GET_STATE 对齐为已开启", $(p, "btnHighlightText").textContent === "停止标记");
    check("计数与内容脚本一致（未互关 5）", $(p, "hlNonMutual").textContent === "5", $(p, "hlNonMutual").textContent);
    p.close();
  }

  console.log("\n=== 用例 4：非「正在关注」页面 -> 按钮禁用、不误发指令 ===");
  {
    const p = makePanel({ url: "https://x.com/home" });
    await sleep(400);

    check("标记按钮被禁用", $(p, "btnHighlight").disabled === true);
    check("未下发任何标记指令", !p.types().some((t) => t.startsWith("HIGHLIGHT")), p.types().join(","));
    p.close();
  }

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
})();

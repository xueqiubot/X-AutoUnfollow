/**
 * tools/test-follow-profile.cjs
 * 用 jsdom 模拟 X 的「个人主页」DOM，验证 content-script.js 里
 * followProfileOnPage()（作者卡片的关注逻辑）的四种结果：
 *   followed / already / unavailable（非目标主页）/ unavailable（无关注入口）
 * 以及「点击后状态未翻转 → failed」的负例。
 *
 * 运行：
 *   NODE_PATH=<node workspace>/node_modules node tools/test-follow-profile.cjs
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.dirname(__dirname);
const SRC = fs.readFileSync(path.join(ROOT, "content", "content-script.js"), "utf8");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  const okMark = cond ? "\u2713" : "\u2717";
  console.log(`  ${okMark} ${name}${extra ? " -> " + extra : ""}`);
  if (cond) pass++;
  else fail++;
}

/**
 * @param {object} opts
 * @param {string} opts.pathname        页面路径，如 "/demo"
 * @param {string} opts.followState     'none' | 'following' | 'broken'
 * @param {boolean} opts.withPrimaryCol 是否渲染 primaryColumn
 */
function runPage({ pathname, followState, withPrimaryCol }) {
  const wide = followState === "following" ? "unfollow" : "follow";
  const mini = followState === "following" ? "unfollow" : "follow";

  const html = `<!DOCTYPE html><html><body>
    <div data-testid="primaryColumn" id="primary">
      <div class="profile">
        <h2>Demo</h2>
        <button data-testid="demo-${wide}" class="wide-btn" style="width:120px">${wide === "unfollow" ? "正在关注" : "关注"}</button>
      </div>
      <article data-testid="tweet">
        <button data-testid="demo-${mini}" class="mini-btn" style="width:34px">${mini === "unfollow" ? "正在关注" : "关注"}</button>
      </article>
    </div>
    ${withPrimaryCol ? "" : `<!-- 无 primaryColumn，回落 document.body -->`}
  </body></html>`;

  const listeners = [];
  const dom = new JSDOM(withPrimaryCol ? html : html.replace('data-testid="primaryColumn"', 'data-testid="notPrimary"'), {
    url: `https://x.com${pathname}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const doc = window.document;
      window.Element.prototype.scrollIntoView = function () {};
      // jsdom 无布局引擎，getBoundingClientRect 恒为 0；按 inline width 造桩，
      // 以便验证「取可见且最宽」的挑选逻辑（资料区按钮应胜过迷你按钮）。
      window.Element.prototype.getBoundingClientRect = function () {
        const w = parseFloat(this.style && this.style.width) || 60;
        return { width: w, height: 24, top: 0, left: 0, right: w, bottom: 24, x: 0, y: 0 };
      };

      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: () => {},
        },
      };

      // 模拟 X：点 follow 按钮后（除非 broken）翻转成 unfollow
      window.__clicked = [];
      doc.addEventListener("click", (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        const btn = t.closest('[data-testid$="-follow"]');
        if (!btn) return;
        window.__clicked.push({ id: btn.getAttribute("data-testid"), w: btn.style.width });
        if (followState === "broken") return; // 点了没反应 → 应当判 failed
        setTimeout(() => {
          btn.setAttribute("data-testid", "demo-unfollow");
          btn.textContent = "正在关注";
        }, 20);
      });
    },
  });

  // 注入 content script
  dom.window.eval(SRC);

  return { dom, listeners, window: dom.window };
}

/** 派发 CS_FOLLOW_PROFILE 并等待异步 sendResponse */
function dispatch(listeners, handle) {
  return new Promise((resolve) => {
    const listener = listeners[0];
    listener({ to: "content", type: "CS_FOLLOW_PROFILE", handle }, null, resolve);
  });
}

(async function main() {
  console.log("\n=== 关注作者主页（followProfileOnPage）验证 ===\n");

  // 用例 1：停在目标主页 + 未关注 → 点击后翻转 → followed
  {
    const { listeners, window: win } = runPage({ pathname: "/demo", followState: "none", withPrimaryCol: true });
    const res = await dispatch(listeners, "demo");
    check("未关注主页 -> followed", res.ok && res.outcome === "followed", JSON.stringify(res));
    const clicked = win.__clicked[0];
    check(
      "点到的是资料区最宽按钮（120px）而非迷你按钮（34px）",
      !!clicked && clicked.w === "120px",
      JSON.stringify(win.__clicked)
    );
  }

  // 用例 2：已关注（存在 unfollow）→ already，且不点击
  {
    const { listeners } = runPage({ pathname: "/demo", followState: "following", withPrimaryCol: true });
    const res = await dispatch(listeners, "demo");
    check("已关注主页 -> already", res.ok && res.outcome === "already", JSON.stringify(res));
  }

  // 用例 3：SPA 还没切到目标主页 → unavailable
  {
    const { listeners } = runPage({ pathname: "/someone-else", followState: "none", withPrimaryCol: true });
    const res = await dispatch(listeners, "demo");
    check("非目标主页 -> unavailable", res.ok && res.outcome === "unavailable", JSON.stringify(res));
  }

  // 用例 4：URL 命中保留路径 x.com/home → 不可误判为主页
  {
    const { listeners } = runPage({ pathname: "/home", followState: "none", withPrimaryCol: true });
    const res = await dispatch(listeners, "home");
    check("保留路径 /home -> unavailable", res.ok && res.outcome === "unavailable", JSON.stringify(res));
  }

  // 用例 5：无 primaryColumn，回落 document.body 仍能定位关注按钮
  {
    const { listeners } = runPage({ pathname: "/demo", followState: "none", withPrimaryCol: false });
    const res = await dispatch(listeners, "demo");
    check("无 primaryColumn 回落 body -> followed", res.ok && res.outcome === "followed", JSON.stringify(res));
  }

  // 用例 6：点击后状态未翻转 → failed（不做无条件报成功）
  {
    const { listeners } = runPage({ pathname: "/demo", followState: "broken", withPrimaryCol: true });
    const res = await dispatch(listeners, "demo");
    check("点击无翻转 -> failed", res.ok && res.outcome === "failed", JSON.stringify(res));
  }

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========\n`);
  process.exit(fail ? 1 : 0);
})();

/**
 * tools/test-content-script.cjs
 * 用 jsdom 模拟 X 的「正在关注」页面 DOM，端到端验证 content-script.js 的
 * 解析 / 过滤 / 取关 / 去重 / 滚动加载 / 熔断 / 中断逻辑。
 *
 * 运行：
 *   NODE_PATH=<node workspace>/node_modules node tools/test-content-script.cjs
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.dirname(__dirname);
const SRC = fs.readFileSync(path.join(ROOT, "content", "content-script.js"), "utf8");

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

// ---------------------------------------------------------------- 页面构造
function userCell({ id, handle, name, followsYou, zh, broken }) {
  const label = zh ? "正在关注" : "Following";
  return `
  <div data-testid="UserCell" class="cell" data-handle="${handle}">
    <a href="/${handle}" class="avatar"><img alt="" /></a>
    <div class="info">
      <a href="/${handle}" class="name">${name}</a>
      <span class="handle">@${handle}</span>
      ${followsYou ? `<span class="badge">${zh ? "关注了你" : "Follows you"}</span>` : ""}
    </div>
    <div class="action">
      <button data-testid="${id}-unfollow" data-broken="${broken ? 1 : 0}" class="btn">${label}</button>
    </div>
  </div>`;
}

function buildPage(cells) {
  return `<!DOCTYPE html><html lang="zh"><body>
    <div id="root">${cells.join("\n")}</div>
  </body></html>`;
}

// ---------------------------------------------------------------- 运行夹具
async function runScenario({ cells, config, testTimings = {}, stopAfterMs = 0, lazyBatches = 0 }) {
  const messages = [];
  const listeners = [];
  let batchesLeft = lazyBatches;
  let batchNo = 0;

  const dom = new JSDOM(buildPage(cells), {
    url: "https://x.com/alice/following",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const doc = window.document;

      // --- 测试时序覆盖 ---
      window.__XUF_TEST__ = Object.assign(
        {
          confirmTimeoutMs: 700,
          stateChangeTimeoutMs: 700,
          backoffMs: 120,
          maxConsecutiveWarn: 2,
          maxConsecutiveStop: 3,
          scrollSettleMs: 20,
          scrollWaitMs: 40,
        },
        testTimings
      );

      // --- 浏览器 API 补齐（jsdom 未实现）---
      window.Element.prototype.scrollIntoView = function () {};
      window.scrollY = 0;
      window.scrollBy = function (dx, dy) {
        window.scrollY += dy || 0;
        if (batchesLeft > 0) {
          batchesLeft--;
          batchNo++;
          const host = doc.getElementById("root");
          for (let i = 0; i < 2; i++) {
            const h = "lazy" + batchNo + "_" + i;
            host.insertAdjacentHTML(
              "beforeend",
              userCell({ id: 9000 + batchNo * 10 + i, handle: h, name: h })
            );
          }
        }
      };

      // --- chrome API 桩 ---
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => listeners.push(fn) },
          sendMessage: (msg) => messages.push(msg),
        },
      };

      // --- 模拟 X 前端的交互行为 ---
      let pendingBtn = null;
      doc.addEventListener("click", (e) => {
        const t = e.target;
        if (!t || !t.closest) return;

        const unfollowBtn = t.closest('[data-testid$="-unfollow"]');
        if (unfollowBtn) {
          if (unfollowBtn.getAttribute("data-broken") === "1") return; // 永不弹出确认框
          pendingBtn = unfollowBtn;
          const zh = /[\u4e00-\u9fa5]/.test(unfollowBtn.textContent);
          setTimeout(() => {
            const dlg = doc.createElement("div");
            dlg.setAttribute("data-testid", "confirmationSheetDialog");
            const b = doc.createElement("button");
            // 一半场景走 data-testid，一半走文案兜底
            if (Math.random() < 0.5) b.setAttribute("data-testid", "confirmationSheetConfirm");
            else b.className = "confirm-fallback";
            b.textContent = zh ? "取消关注" : "Unfollow";
            dlg.appendChild(b);
            doc.body.appendChild(dlg);
          }, 30);
          return;
        }

        const confirmBtn = t.closest('[data-testid="confirmationSheetConfirm"], .confirm-fallback');
        if (confirmBtn && pendingBtn) {
          const btn = pendingBtn;
          pendingBtn = null;
          const id = (btn.getAttribute("data-testid") || "").replace("-unfollow", "");
          const zh = /[\u4e00-\u9fa5]/.test(btn.textContent);
          setTimeout(() => {
            btn.setAttribute("data-testid", id + "-follow");
            btn.textContent = zh ? "关注" : "Follow";
            const dlg = confirmBtn.closest('[data-testid="confirmationSheetDialog"]');
            if (dlg) dlg.remove();
          }, 20);
        }
      });
    },
  });

  // 注入 content script
  dom.window.eval(SRC);

  const dispatch = (msg) => {
    let resp = null;
    for (const fn of listeners) fn(msg, {}, (r) => (resp = r));
    return resp;
  };

  const started = dispatch({ to: "content", type: "START", config });
  check("START 指令返回 ok", started && started.ok === true);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (stopAfterMs > 0 && Date.now() > deadline - 30000 + stopAfterMs) {
      dispatch({ to: "content", type: "STOP" });
      stopAfterMs = 0;
    }
    if (messages.some((m) => m.kind === "FINISH")) break;
    await new Promise((r) => setTimeout(r, 30));
  }

  const finish = [...messages].reverse().find((m) => m.kind === "FINISH");
  const logs = messages.filter((m) => m.kind === "LOG").map((m) => m.data.message);
  const win = dom.window;

  return { messages, finish, logs, win, dom };
}

// ================================================================ 用例
(async () => {
  console.log("\n=== 用例 1：英文界面 + 互关保护 + 白名单 ===");
  {
    const r = await runScenario({
      cells: [
        userCell({ id: 101, handle: "alice", name: "Alice" }),
        userCell({ id: 102, handle: "bob", name: "Bob", followsYou: true }),
        userCell({ id: 103, handle: "carol", name: "Carol" }),
        userCell({ id: 104, handle: "dave", name: "Dave" }),
      ],
      config: { whitelist: ["carol"], protectMutual: true, maxUnfollow: 50, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("已取关 = 2 (alice, dave)", s.unfollowed === 2, "got " + s.unfollowed);
    check("互关跳过 = 1 (bob)", s.skippedMutual === 1, "got " + s.skippedMutual);
    check("白名单跳过 = 1 (carol)", s.skippedWhitelist === 1, "got " + s.skippedWhitelist);
    check("失败 = 0", s.failed === 0, "got " + s.failed);
    const btns = [...r.win.document.querySelectorAll('[data-testid="UserCell"] button')];
    check(
      "DOM 中 alice/dave 按钮已变为 -follow",
      btns.filter((b) => /-follow$/.test(b.getAttribute("data-testid") || "")).length === 2,
      btns.map((b) => b.getAttribute("data-testid")).join(",")
    );
  }

  console.log("\n=== 用例 2：中文界面（正在关注 / 取消关注）+ 互关中文标签 ===");
  {
    const r = await runScenario({
      cells: [
        userCell({ id: 201, handle: "zhang", name: "张三", zh: true }),
        userCell({ id: 202, handle: "li", name: "李四", zh: true, followsYou: true }),
      ],
      config: { whitelist: [], protectMutual: true, maxUnfollow: 50, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("已取关 = 1 (zhang)", s.unfollowed === 1, "got " + s.unfollowed);
    check("互关跳过 = 1 (li)", s.skippedMutual === 1, "got " + s.skippedMutual);
  }

  console.log("\n=== 用例 3：关闭互关保护 -> 互关用户也会被取关 ===");
  {
    const r = await runScenario({
      cells: [
        userCell({ id: 301, handle: "alice", name: "Alice" }),
        userCell({ id: 302, handle: "bob", name: "Bob", followsYou: true }),
      ],
      config: { whitelist: [], protectMutual: false, maxUnfollow: 50, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("已取关 = 2", s.unfollowed === 2, "got " + s.unfollowed);
    check("互关跳过 = 0", s.skippedMutual === 0, "got " + s.skippedMutual);
  }

  console.log("\n=== 用例 4：单次上限熔断（上限 2，共 5 人）===");
  {
    const r = await runScenario({
      cells: [1, 2, 3, 4, 5].map((i) => userCell({ id: 400 + i, handle: "u" + i, name: "U" + i })),
      config: { whitelist: [], protectMutual: true, maxUnfollow: 2, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("已取关 = 2（被上限截断）", s.unfollowed === 2, "got " + s.unfollowed);
    check("日志提示达到上限", r.logs.some((l) => /达到单次上限/.test(l)), r.logs.slice(-3).join(" | "));
  }

  console.log("\n=== 用例 5：演练模式（不产生真实点击）===");
  {
    const r = await runScenario({
      cells: [
        userCell({ id: 501, handle: "alice", name: "Alice" }),
        userCell({ id: 502, handle: "bob", name: "Bob" }),
      ],
      config: { whitelist: [], protectMutual: true, maxUnfollow: 50, delayMin: 0, delayMax: 0, dryRun: true },
    });
    const s = r.finish?.data || {};
    check("演练计数 = 2", s.unfollowed === 2, "got " + s.unfollowed);
    const btns = [...r.win.document.querySelectorAll('[data-testid="UserCell"] button')];
    check(
      "DOM 未被改动（按钮仍为 -unfollow）",
      btns.every((b) => /-unfollow$/.test(b.getAttribute("data-testid") || "")),
      btns.map((b) => b.getAttribute("data-testid")).join(",")
    );
    check("日志包含 [演练]", r.logs.some((l) => l.includes("[演练]")));
  }

  console.log("\n=== 用例 6：滚动加载 + 去重 ===");
  {
    const r = await runScenario({
      cells: [
        userCell({ id: 601, handle: "alice", name: "Alice" }),
        userCell({ id: 602, handle: "bob", name: "Bob" }),
      ],
      lazyBatches: 2, // 每次下滑追加 2 个用户，共追加 2 批
      config: { whitelist: [], protectMutual: true, maxUnfollow: 50, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("扫描总数 = 6（2 初始 + 4 懒加载）", s.scanned === 6, "got " + s.scanned);
    check("已取关 = 6", s.unfollowed === 6, "got " + s.unfollowed);
    check("日志出现结束提示", r.logs.some((l) => /没有更多可处理的用户/.test(l)), r.logs.slice(-2).join(" | "));
  }

  console.log("\n=== 用例 7：STOP 中断 ===");
  {
    const r = await runScenario({
      cells: [1, 2, 3, 4, 5, 6].map((i) => userCell({ id: 700 + i, handle: "s" + i, name: "S" + i })),
      config: { whitelist: [], protectMutual: true, maxUnfollow: 50, delayMin: 400, delayMax: 500 },
      stopAfterMs: 700,
    });
    const s = r.finish?.data || {};
    check("被中断后停止（取关 < 6）", s.unfollowed < 6, "got " + s.unfollowed);
    check("日志出现中断提示", r.logs.some((l) => /停止指令|中断/.test(l)), r.logs.slice(-3).join(" | "));
  }

  console.log("\n=== 用例 8：连续失败 -> 自动熔断 ===");
  {
    const r = await runScenario({
      cells: [1, 2, 3, 4, 5].map((i) =>
        userCell({ id: 800 + i, handle: "b" + i, name: "B" + i, broken: true })
      ),
      testTimings: { maxConsecutiveWarn: 2, maxConsecutiveStop: 3, backoffMs: 50, confirmTimeoutMs: 60 },
      config: { whitelist: [], protectMutual: true, maxUnfollow: 50, delayMin: 0, delayMax: 0 },
    });
    const s = r.finish?.data || {};
    check("失败计数 >= 3", (s.failed || 0) >= 3, "got " + s.failed);
    check("取关数为 0", s.unfollowed === 0, "got " + s.unfollowed);
    check("日志出现熔断", r.logs.some((l) => /熔断/.test(l)), r.logs.slice(-3).join(" | "));
  }

  console.log("\n=== 用例 9：非 following 页面直接拒绝 ===");
  {
    const dom = new JSDOM(buildPage([userCell({ id: 901, handle: "alice", name: "Alice" })]), {
      url: "https://x.com/home",
      runScripts: "dangerously",
      beforeParse(window) {
        window.__XUF_TEST__ = { scrollSettleMs: 20, scrollWaitMs: 40 };
        window.Element.prototype.scrollIntoView = function () {};
        window.chrome = {
          runtime: { onMessage: { addListener: (fn) => (window.__L = fn) }, sendMessage: (m) => (window.__M = window.__M || []).push(m) },
        };
      },
    });
    dom.window.eval(SRC);
    dom.window.__L({ to: "content", type: "START", config: {} }, {}, () => {});
    await new Promise((r) => setTimeout(r, 300));
    const msgs = dom.window.__M || [];
    check("未执行任何取关", !msgs.some((m) => m.kind === "STATE" && m.data.unfollowed > 0));
    check("日志提示非目标页面", msgs.some((m) => m.kind === "LOG" && /不是“正在关注”页面/.test(m.data.message)));
  }

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
})();

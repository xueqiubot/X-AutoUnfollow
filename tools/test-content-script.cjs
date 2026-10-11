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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建一个模拟 X「正在关注」页面的 jsdom 环境（含 chrome API 桩与交互模拟）。
 * 自动取关与未互关标记两组用例共用，避免两份几乎一样的 mock 漂移。
 */
function makeDom({ cells, url = "https://x.com/alice/following", testTimings = {}, lazyBatches = 0 }) {
  const messages = [];
  const listeners = [];
  let batchesLeft = lazyBatches;
  let batchNo = 0;

  const dom = new JSDOM(buildPage(cells), {
    url,
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
          highlightScanThrottleMs: 20,
          highlightTickMs: 60,
          highlightReportMs: 20,
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

  return { dom, win: dom.window, messages, listeners };
}

function makeDispatcher(listeners) {
  return (msg) => {
    let resp = null;
    for (const fn of listeners) fn(msg, {}, (r) => (resp = r));
    return resp;
  };
}

async function runScenario({ cells, config, testTimings = {}, stopAfterMs = 0, lazyBatches = 0 }) {
  const { dom, win, messages, listeners } = makeDom({ cells, testTimings, lazyBatches });

  // 注入 content script
  win.eval(SRC);

  const dispatch = makeDispatcher(listeners);

  const started = dispatch({ to: "content", type: "START", config });
  check("START 指令返回 ok", started && started.ok === true);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (stopAfterMs > 0 && Date.now() > deadline - 30000 + stopAfterMs) {
      dispatch({ to: "content", type: "STOP" });
      stopAfterMs = 0;
    }
    if (messages.some((m) => m.kind === "FINISH")) break;
    await sleep(30);
  }

  const finish = [...messages].reverse().find((m) => m.kind === "FINISH");
  const logs = messages.filter((m) => m.kind === "LOG").map((m) => m.data.message);

  return { messages, finish, logs, win, dom };
}

// ------------------------------------------------- 未互关标记（手动取关）夹具
async function runHighlightScenario({ cells, config = {}, url, testTimings = {} }) {
  const { dom, win, messages, listeners } = makeDom({ cells, url, testTimings });
  win.eval(SRC);
  const dispatch = makeDispatcher(listeners);

  const resp = dispatch({ to: "content", type: "HIGHLIGHT_START", config });
  await sleep(200); // 等首轮扫描 + 上报

  const doc = win.document;
  return {
    dom,
    win,
    doc,
    messages,
    dispatch,
    resp,
    logs: messages.filter((m) => m.kind === "LOG").map((m) => m.data.message),
    cell: (h) => doc.querySelector(`[data-testid="UserCell"][data-handle="${h}"]`),
    lastHl: () => [...messages].reverse().find((m) => m.kind === "HIGHLIGHT"),
    stop() {
      dispatch({ to: "content", type: "HIGHLIGHT_STOP" });
      win.close(); // 关掉 jsdom 定时器，避免测试进程被 interval 挂住
    },
  };
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

  console.log("\n=== 用例 10：未互关标记 —— 未互关 / 互关 / 白名单 三态 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [
        userCell({ id: 1001, handle: "alice", name: "Alice" }),
        userCell({ id: 1002, handle: "bob", name: "Bob", followsYou: true }),
        userCell({ id: 1003, handle: "carol", name: "Carol" }),
      ],
      config: { whitelist: ["carol"], protectMutual: true },
    });

    check("HIGHLIGHT_START 返回 ok", ctx.resp && ctx.resp.ok === true, JSON.stringify(ctx.resp));
    check("样式表已注入页面", !!ctx.doc.getElementById("xuf-highlight-style"));

    // 回归防线（v1.1.0/v1.1.1 两次翻车的根因）：
    //  1) 样式必须挂在 data-xuf-mark 属性上 —— X 的 React 在悬停重渲染时会按 className 重写
    //     class，把我们的类名冲掉；一旦颜色/变量依赖 class，标记就会变透明、徽标回退成灰色；
    //  2) 底色必须画在 ::before 覆盖层上，而不是改 cell 的 background-color（会被 X 重画的
    //     行背景盖掉）；覆盖层要建独立层叠上下文并压过行内元素。
    const css = ctx.doc.getElementById("xuf-highlight-style").textContent;
    check(
      "颜色变量挂在 data-xuf-mark 上（class 被 React 冲掉也不失效）",
      /\[data-xuf-mark="nonMutual"\]\{--xuf-tag-bg:/.test(css) && !/\.xuf-nonmutual\s*\{/.test(css),
      css
    );
    check(
      "标记底色画在 ::before 覆盖层（不依赖 cell 背景）",
      /\[data-xuf-mark\]::before\{[^}]*background:var\(--xuf-bg/.test(css) &&
        !/background-color:rgba\(244,33,46/.test(css),
      css
    );
    check(
      "存在 :hover 覆盖层规则（滑过时保持标记颜色）",
      /\[data-xuf-mark\]:hover::before/.test(css)
    );
    check(
      "覆盖层建独立层叠上下文、z-index 压过行内元素、且不挡点击",
      /\[data-xuf-mark\]\{position:relative;isolation:isolate\}/.test(css) &&
        /\[data-xuf-mark\]::before\{[^}]*z-index:9[^}]*pointer-events:none/.test(css) &&
        /\[data-xuf-mark\]::after\{[^}]*z-index:10/.test(css)
    );
    check("alice（未互关）被标红", ctx.cell("alice").classList.contains("xuf-nonmutual"));
    check("bob（互关）标记为互关", ctx.cell("bob").classList.contains("xuf-mutual"));
    check("carol（白名单）标记为白名单", ctx.cell("carol").classList.contains("xuf-whitelist"));
    check(
      "徽标文案写入 data-xuf-tag",
      ctx.cell("alice").getAttribute("data-xuf-tag") === "未互关",
      String(ctx.cell("alice").getAttribute("data-xuf-tag"))
    );

    const hl = ctx.lastHl()?.data || {};
    check(
      "上报计数：未互关 1 / 互关 1 / 白名单 1",
      hl.nonMutual === 1 && hl.mutual === 1 && hl.whitelisted === 1,
      JSON.stringify(hl)
    );
    check("上报 on=true", hl.on === true, JSON.stringify(hl));
    ctx.stop();
  }

  console.log("\n=== 用例 11：手动取关后该行转为「已取关」并变灰 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [
        userCell({ id: 1101, handle: "alice", name: "Alice" }),
        userCell({ id: 1102, handle: "bob", name: "Bob", followsYou: true }),
      ],
      config: {},
    });
    check("初始 alice 为未互关", ctx.cell("alice").classList.contains("xuf-nonmutual"));

    // 模拟用户手动取关：点按钮 -> 确认弹窗 -> 确认
    ctx.cell("alice").querySelector('[data-testid$="-unfollow"]').click();
    await sleep(90);
    const confirm = ctx.doc.querySelector(
      '[data-testid="confirmationSheetConfirm"], .confirm-fallback'
    );
    check("确认弹窗已出现", !!confirm);
    confirm.click();
    await sleep(400); // 等按钮翻转 + 下一轮扫描

    check(
      "alice 转为「已取关」标记",
      ctx.cell("alice").classList.contains("xuf-unfollowed"),
      ctx.cell("alice").className
    );
    check("已取关后不再标红", !ctx.cell("alice").classList.contains("xuf-nonmutual"));
    check(
      "徽标文案变为「已取关」",
      ctx.cell("alice").getAttribute("data-xuf-tag") === "已取关",
      String(ctx.cell("alice").getAttribute("data-xuf-tag"))
    );

    const hl = ctx.lastHl()?.data || {};
    check(
      "计数：未互关 0 / 已取关 1（互关仍为 1）",
      hl.nonMutual === 0 && hl.done === 1 && hl.mutual === 1,
      JSON.stringify(hl)
    );
    ctx.stop();
  }

  console.log("\n=== 用例 12：关闭标记 -> 页面标记全部清除 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [userCell({ id: 1201, handle: "alice", name: "Alice" })],
      config: {},
    });
    check("开启后已标红", ctx.cell("alice").classList.contains("xuf-nonmutual"));

    ctx.dispatch({ to: "content", type: "HIGHLIGHT_STOP" });
    await sleep(120);

    const cell = ctx.cell("alice");
    check(
      "标记类已移除",
      !cell.className.includes("xuf-"),
      cell.className
    );
    check("徽标属性已移除", !cell.hasAttribute("data-xuf-tag"));
    const hl = ctx.lastHl()?.data || {};
    check("上报 on=false 且计数归零", hl.on === false && hl.nonMutual === 0, JSON.stringify(hl));
    ctx.win.close();
  }

  console.log("\n=== 用例 13：滚动/懒加载新增的节点会被自动标记 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [userCell({ id: 1301, handle: "alice", name: "Alice" })],
      config: {},
    });
    ctx.doc
      .getElementById("root")
      .insertAdjacentHTML("beforeend", userCell({ id: 1302, handle: "newbie", name: "Newbie" }));
    await sleep(300);

    check("新增节点被自动标红", ctx.cell("newbie").classList.contains("xuf-nonmutual"));
    const hl = ctx.lastHl()?.data || {};
    check("计数已包含新增用户（未互关 2）", hl.nonMutual === 2, JSON.stringify(hl));
    ctx.stop();
  }

  console.log("\n=== 用例 14：非 following 页面拒绝开启标记 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [userCell({ id: 1401, handle: "alice", name: "Alice" })],
      url: "https://x.com/home",
      config: {},
    });
    check(
      "HIGHLIGHT_START 返回 ok=false",
      ctx.resp && ctx.resp.ok === false,
      JSON.stringify(ctx.resp)
    );
    check("页面未被打标", !ctx.cell("alice").classList.contains("xuf-nonmutual"));
    check(
      "日志提示非目标页面",
      ctx.logs.some((l) => /不是“正在关注”页面/.test(l)),
      ctx.logs.join(" | ")
    );
    ctx.win.close();
  }

  console.log("\n=== 用例 15：X 重渲染按 className 重写 class 后，标记仍然有效 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [userCell({ id: 1501, handle: "alice", name: "Alice" })],
      config: {},
    });
    const cell = ctx.cell("alice");
    check("初始已标红", cell.classList.contains("xuf-nonmutual"));

    // 模拟 X 的 React 重渲染（悬停时常见）：按 className 整体重写 class，把我们的类冲掉。
    // data-* 属性不归 React 管，因此必须仍然保持标记有效。
    cell.className = "cell";
    check("属性未被 React 影响（样式依赖它）",
      cell.getAttribute("data-xuf-mark") === "nonMutual" && cell.getAttribute("data-xuf-tag") === "未互关",
      cell.outerHTML.slice(0, 100));

    await sleep(200); // 等下一轮扫描
    check("class 被自动补回（便于调试）", cell.classList.contains("xuf-nonmutual"), cell.className);
    check("data-xuf-mark 仍在（标记不依赖 class）", cell.getAttribute("data-xuf-mark") === "nonMutual");
    check("样式表里没有以 .xuf- 类为选择器的颜色规则",
      !/\.xuf-nonmutual\s*\{/.test(ctx.doc.getElementById("xuf-highlight-style").textContent));
    ctx.stop();
  }

  console.log("\n=== 用例 16：React 重建节点（属性全丢）后会被重新标记 ===");
  {
    const ctx = await runHighlightScenario({
      cells: [userCell({ id: 1601, handle: "alice", name: "Alice" })],
      config: {},
    });
    const old = ctx.cell("alice");
    const fresh = ctx.doc.createElement("div");
    fresh.setAttribute("data-testid", "UserCell");
    fresh.setAttribute("data-handle", "alice");
    fresh.className = "cell";
    fresh.innerHTML = old.innerHTML;
    old.replaceWith(fresh); // 干净的新节点，没有任何 xuf 属性
    await sleep(250);

    const now = ctx.cell("alice");
    check("新节点被重新打标", now.classList.contains("xuf-nonmutual"), now.outerHTML.slice(0, 120));
    check("新节点带上了 data-xuf-mark / data-xuf-tag",
      now.getAttribute("data-xuf-mark") === "nonMutual" && now.getAttribute("data-xuf-tag") === "未互关");
    const hl = ctx.lastHl()?.data || {};
    check("计数未因节点重建而漂移（未互关 1）", hl.nonMutual === 1, JSON.stringify(hl));
    ctx.stop();
  }

  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  if (fail) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exitCode = 1;
  }
})();

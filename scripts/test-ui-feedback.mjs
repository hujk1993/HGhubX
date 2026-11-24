import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

// 两条契约的真实浏览器回归（mock Tauri IPC，不访问上游网络）：
//   1. 同 tag toast（如 playback-hint 统一承载播放提示）原地替换 + 重置计时；无 tag 仍正常堆叠。
//   2. 宽屏 .ios-page 标题头栏与滚动体限宽居中、两侧留白对称；窄屏仍全宽。
// 探针页 tests/ui-feedback.html 挂载真实 Profile（.ios-page 消费者）、ToastHost 与 store。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "ui-feedback", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real Profile, ToastHost and store in Chromium; mocked Tauri IPC; not native verification", passed: [], external: [] };
let vite, browser, page;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toastCount = () => page.evaluate(() => document.querySelectorAll(".a-toast").length);

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    report.external.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(installFixture, { theme: "dark", titles: ["示例一", "示例二", "示例三"] });
  await page.goto(`${origin}tests/ui-feedback.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.uiFeedbackProbe && document.querySelector(".ios-page > .shrink-0") && document.querySelector(".ios-page > .scroll-y"));

  // ---- 契约 2：宽屏限宽居中 ----
  const measure = () => page.evaluate(() => {
    const page = document.querySelector(".ios-page");
    const head = document.querySelector(".ios-page > .shrink-0");
    const body = document.querySelector(".ios-page > .scroll-y");
    const r = el => {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { width: b.width, left: b.left, right: b.right, paddingLeft: parseFloat(s.paddingLeft), paddingRight: parseFloat(s.paddingRight) };
    };
    return { viewport: window.innerWidth, page: r(page), head: r(head), body: r(body) };
  });
  // 关闭过渡/动画并等待布局稳定：.ios-page 的 padding 过渡会在中间态产生瞬时偏移，
  // 几何契约只约束最终居中布局，测量前必须排除过渡帧噪声。
  const settle = async () => {
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important;}" });
    await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  };
  await settle();
  report.geometry = { wide: [], narrow: [] };
  for (const [width, height] of [[768, 1024], [1024, 768], [1280, 900]]) {
    await page.setViewportSize({ width, height });
    const wide = await measure();
    report.geometry.wide.push(wide);
    for (const part of [wide.head, wide.body]) {
      assert.ok(part.width < wide.viewport - 1, `宽屏应限宽：width=${part.width} viewport=${wide.viewport}`);
      assert.ok(part.width <= 960 + 0.5, `宽屏上限 960：width=${part.width}`);
      const leftGap = part.left - wide.page.left;
      const rightGap = wide.page.right - part.right;
      assert.ok(leftGap > 1, `宽屏应有左留白：leftGap=${leftGap}`);
      assert.ok(Math.abs(leftGap - rightGap) <= 1, `宽屏留白应对称：left=${leftGap} right=${rightGap}`);
    }
    assert.ok(Math.abs(wide.head.width - wide.body.width) <= 1 && Math.abs(wide.head.left - wide.body.left) <= 1, "头栏与滚动体应等宽对齐");
  }
  await page.screenshot({ path: join(output, "wide.png") });
  report.passed.push("wide-centering");

  // ---- 契约 2：窄屏仍全宽 ----
  for (const [width, height, safeLeft, safeRight] of [[320, 568, 0, 0], [390, 844, 0, 0], [667, 375, 44, 16]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(([left, right]) => {
      document.documentElement.style.setProperty("--sal", `${left}px`);
      document.documentElement.style.setProperty("--sar", `${right}px`);
    }, [safeLeft, safeRight]);
    const narrow = await measure();
    report.geometry.narrow.push(narrow);
    for (const part of [narrow.head, narrow.body]) {
      assert.ok(Math.abs(part.width - narrow.viewport) <= 1, `窄屏应全宽：width=${part.width} viewport=${narrow.viewport}`);
      assert.ok(Math.abs(part.left - narrow.page.left) <= 1, `窄屏应贴左：left=${part.left}`);
      assert.ok(part.paddingLeft >= safeLeft + 17 && part.paddingRight >= safeRight + 17, "内容应避开两侧系统安全区");
      assert.ok(Math.abs(part.paddingLeft - part.paddingRight - safeLeft + safeRight) <= 1, "两侧应各自使用对应的安全区");
    }
  }
  await page.screenshot({ path: join(output, "narrow.png") });
  report.passed.push("narrow-full-width");

  // ---- 契约 1：同 tag 原地替换，不堆叠 ----
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--sal");
    document.documentElement.style.removeProperty("--sar");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 0);
  await page.evaluate(() => {
    for (let ep = 1; ep <= 5; ep++) window.uiFeedbackProbe.toast(`第 ${ep} 集 / 24`, "info", "episode");
  });
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 1);
  assert.equal(await toastCount(), 1, "快速同 tag 触发只应有一张卡片");
  const dedup = await page.evaluate(() => {
    const list = window.uiFeedbackProbe.toasts();
    return { count: list.length, tag: list[0]?.tag, msg: list[0]?.msg, text: document.querySelector(".a-toast")?.textContent ?? "" };
  });
  assert.equal(dedup.count, 1);
  assert.equal(dedup.tag, "episode");
  assert.ok(dedup.msg.includes("第 5 集"), `应原地换成最新内容：${dedup.msg}`);
  assert.ok(dedup.text.includes("第 5 集"), `卡片应显示最新内容：${dedup.text}`);
  report.toast = { dedup };
  report.passed.push("toast-same-tag-dedup");

  // ---- 契约 1：同 tag 再次触发重置计时 ----
  await sleep(1500); // < 2200ms ttl，首次触发后仍在
  assert.equal(await toastCount(), 1, "ttl 内卡片应仍在");
  await page.evaluate(() => window.uiFeedbackProbe.toast("第 6 集 / 24", "info", "episode")); // 重置计时
  await sleep(1500); // 距首次触发已经 3000ms（> 2200），但距重置只 1500ms → 仍应在
  assert.equal(await toastCount(), 1, "同 tag 重置计时后卡片应续命");
  const resetMsg = await page.evaluate(() => window.uiFeedbackProbe.toasts()[0]?.msg ?? "");
  assert.ok(resetMsg.includes("第 6 集"), `重置后应显示新内容：${resetMsg}`);
  await sleep(2400); // 距重置 > 2200ms → 消失
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 0);
  report.passed.push("toast-ttl-reset");

  // ---- 契约 1：播放提示共用 playback-hint 单槽，无 tag 普通提示仍保留堆叠 ----
  await page.evaluate(() => {
    window.uiFeedbackProbe.toast("已锁定屏幕", "info", "playback-hint");
    window.uiFeedbackProbe.toast("第 5 集 / 24", "info", "playback-hint");
    window.uiFeedbackProbe.toast("上下划切集已开启", "info", "playback-hint");
  });
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 1);
  assert.equal(await toastCount(), 1, "播放提示共用 playback-hint 时只保留一张卡片");
  const latest = await page.evaluate(() => {
    const list = window.uiFeedbackProbe.toasts();
    return { count: list.length, msg: list[0]?.msg, text: document.querySelector(".a-toast")?.textContent ?? "" };
  });
  assert.equal(latest.count, 1);
  assert.equal(latest.msg, "上下划切集已开启");
  assert.ok(latest.text.includes("上下划切集已开启"), `卡片应换成最后一条播放提示：${latest.text}`);
  await sleep(2400);
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 0);

  // ---- 契约 1：点赞/收藏连续触发共用 playback-hint 单槽 ----
  await page.evaluate(async () => {
    await window.feedActionProbe.fav();
    await window.feedActionProbe.fav();
    await window.feedActionProbe.like();
  });
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 1);
  assert.equal(await toastCount(), 1, "连续点赞/收藏应只保留一张卡片");
  const actionToast = await page.evaluate(() => {
    const list = window.uiFeedbackProbe.toasts();
    return { count: list.length, tag: list[0]?.tag, msg: list[0]?.msg, text: document.querySelector(".a-toast")?.textContent ?? "" };
  });
  assert.equal(actionToast.count, 1);
  assert.equal(actionToast.tag, "playback-hint");
  assert.equal(actionToast.msg, "已加入喜欢");
  assert.ok(actionToast.text.includes("已加入喜欢"), `卡片应换成最后一次操作提示：${actionToast.text}`);
  report.toast.action = actionToast;
  report.passed.push("toast-feed-action-single-slot");
  await page.locator(".a-toast").screenshot({ path: join(output, "feed-action-toast.png") });
  await sleep(2400);
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 0);

  await page.evaluate(() => {
    window.uiFeedbackProbe.toast("普通提示 A", "info");
    window.uiFeedbackProbe.toast("普通提示 B", "ok");
  });
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 2);
  assert.equal(await toastCount(), 2, "无 tag 提示应各自堆叠");
  await page.screenshot({ path: join(output, "toast.png") });
  report.toast.latest = latest;
  report.passed.push("toast-playback-hint-and-untagged-stack");

  assert.deepEqual(errors, [], `页面运行时错误：${errors.join(" | ")}`);
  console.log(`PASS: ui-feedback (${report.passed.length} contracts)`);
  console.log(JSON.stringify({ geometry: report.geometry, toast: report.toast }, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}

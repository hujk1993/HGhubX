import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/profile-swipe/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real Profile in Chromium with mocked Tauri IPC and touch input", checks: [], errors: [] };
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["示例一", "示例二", "示例三"] });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/ui-feedback.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page-body").waitFor();
  await page.getByRole("button", { name: "我的收藏", exact: true }).waitFor();
  await page.waitForTimeout(420);

  const activeTab = () => page.locator('[aria-label="我的内容"] button[aria-pressed="true"]').innerText();
  assert.equal(await activeTab(), "我的收藏");
  const cdp = await context.newCDPSession(page);
  const swipe = async (dx, dy = 0) => {
    const box = await page.locator(".ios-page-body").boundingBox();
    assert.ok(box);
    const x = box.x + box.width - 26;
    const y = box.y + Math.min(220, box.height * 0.28);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6, id: 1 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(140);
  };

  await swipe(-128);
  await page.waitForFunction(() => document.querySelector('[aria-label="我的内容"] button[aria-pressed="true"]')?.textContent === "观看历史");
  assert.equal(await activeTab(), "观看历史");
  await page.screenshot({ path: fileURLToPath(new URL("profile-history.png", output)), animations: "disabled" });
  report.checks.push("swipe left switches 我的收藏 → 观看历史");

  await swipe(-128);
  await page.waitForTimeout(140);
  assert.equal(await activeTab(), "观看历史", "The last tab must not wrap to the first tab");
  report.checks.push("swipe left on 观看历史 stays put");

  await swipe(128);
  await page.waitForFunction(() => document.querySelector('[aria-label="我的内容"] button[aria-pressed="true"]')?.textContent === "我的收藏");
  assert.equal(await activeTab(), "我的收藏");
  report.checks.push("swipe right returns 观看历史 → 我的收藏");

  await swipe(6, 120);
  await page.waitForTimeout(140);
  assert.equal(await activeTab(), "我的收藏", "Vertical swipe must not switch tabs");
  report.checks.push("vertical scroll does not switch tabs");

  await page.locator(".ios-page-body").evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: fileURLToPath(new URL("profile-swipe.png", output)), animations: "disabled" });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: profile-swipe (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}

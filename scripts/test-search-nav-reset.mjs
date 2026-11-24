import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/search-nav-reset/", import.meta.url);
await mkdir(output, { recursive: true });
const report = { environment: "Real App shell in Chromium with mocked Tauri IPC", checks: [], errors: [] };
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
    viewport: { width: 430, height: 932 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["仙侠归来", "城市与晚风", "星河旅人"] });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/search-nav-reset.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".hg-tabbar").waitFor();

  const searchNav = page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "搜索" });
  await searchNav.click();
  const input = page.getByRole("textbox", { name: "搜索短剧、帖子、题材…" });
  await input.waitFor();
  assert.equal(await searchNav.getAttribute("aria-current"), "page");
  report.checks.push("bottom nav opens the Search tab");

  await input.fill("仙侠");
  await input.press("Enter");
  const segmented = page.locator('[aria-label="搜索结果类型"]');
  await segmented.waitFor();
  await page.screenshot({ path: fileURLToPath(new URL("search-nav-reset-before.png", output)), animations: "disabled" });
  report.checks.push("query submits and renders results");

  await searchNav.click();
  await page.waitForFunction(() => {
    const field = document.querySelector('input[aria-label="搜索短剧、帖子、题材…"]');
    return field instanceof HTMLInputElement && field.value === "";
  });
  assert.equal(await segmented.count(), 0, "query result type switch must be removed");
  await page.locator('[aria-label="热搜榜"]').waitFor();
  assert.equal(await searchNav.getAttribute("aria-current"), "page", "Search tab must stay active");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), null, "input must blur so the mobile keyboard closes");
  await page.screenshot({ path: fileURLToPath(new URL("search-nav-reset-after.png", output)), animations: "disabled" });
  report.checks.push("re-tapping Search resets the current search and keeps the tab active");

  await input.fill("仙侠");
  await input.press("Enter");
  await segmented.waitFor();
  await page.locator('[aria-label="清空搜索"]').click();
  await page.waitForFunction(() => {
    const field = document.querySelector('input[aria-label="搜索短剧、帖子、题材…"]');
    return field instanceof HTMLInputElement && field.value === "";
  });
  assert.equal(await segmented.count(), 0, "clear button must still reset the search");
  report.checks.push("search-box clear button still resets the search");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: search-nav-reset (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}

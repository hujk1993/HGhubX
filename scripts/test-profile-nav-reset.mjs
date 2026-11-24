import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/profile-nav-reset/", import.meta.url);
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
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["甲", "乙", "丙", "丁", "戊", "己"] });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });
  await page.goto(new URL("/tests/profile-nav-reset.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".hg-tabbar").waitFor();

  const profileNav = page.locator(".hg-tabbar .ios-mobile-nav-item").filter({ hasText: "我的" });
  await profileNav.click();
  await page.getByRole("button", { name: "我的收藏", exact: true }).waitFor();
  const filterButton = page.locator('[aria-label="收藏状态筛选"] button[aria-haspopup="menu"]');
  await filterButton.waitFor();
  const menu = page.getByRole("menu", { name: "追剧状态" });
  const activeLabel = page.locator(".ios-filter-active-label");

  await filterButton.click();
  await menu.waitFor();
  await page.getByRole("menuitemradio", { name: /在追剧/ }).click();
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector(".ios-filter-active-label")?.textContent?.startsWith("在追剧"));
  await page.screenshot({ path: fileURLToPath(new URL("profile-filter-active.png", output)), animations: "disabled" });

  // The old bug: re-opening the filter menu from the active pill reset to all.
  await filterButton.click();
  await menu.waitFor();
  assert.match(await activeLabel.innerText(), /^在追剧 \d+$/);
  await page.screenshot({ path: fileURLToPath(new URL("profile-filter-reopen.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  report.checks.push("active filter pill re-opens the menu without resetting to all favorites");

  // Tapping the active Profile tab is the deliberate reset gesture.
  await profileNav.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="收藏状态筛选"] button')?.getAttribute("aria-pressed") === "false");
  assert.equal(await activeLabel.count(), 0);
  assert.equal(await page.getByRole("button", { name: "我的收藏", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".ios-poster-title").count(), 6);
  await page.screenshot({ path: fileURLToPath(new URL("profile-filter-default.png", output)), animations: "disabled" });
  report.checks.push("re-tapping 我的 restores 我的收藏 default with all favorites");

  await page.getByRole("button", { name: "观看历史", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="我的内容"] button[aria-pressed="true"]')?.textContent === "观看历史");
  await profileNav.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="我的内容"] button[aria-pressed="true"]')?.textContent === "我的收藏");
  report.checks.push("re-tapping 我的 also returns 观看历史 to 我的收藏");

  await page.evaluate(() => window.dispatchEvent(new Event("hg:profile-reset")));
  await page.waitForFunction(() => document.querySelector('[aria-label="收藏状态筛选"] button')?.getAttribute("aria-pressed") === "false");
  report.checks.push("profile reset event is idempotent on the default page");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: profile-nav-reset (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}

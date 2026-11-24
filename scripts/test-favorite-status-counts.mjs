import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/favorite-filter/", import.meta.url);
await mkdir(output, { recursive: true });
const rows = [
  [1, "更新一", false, "2026-11-23T10:00:00Z"], [2, "完结二", true, "2026-11-22T10:00:00Z"],
  [3, "更新三", false, "2026-11-21T10:00:00Z"], [4, "完结四", true, "2026-11-20T10:00:00Z"],
  [5, "更新五", false, "2026-11-19T10:00:00Z"], [6, "完结六", true, "2026-11-18T10:00:00Z"],
].map(([id, title, is_finished, updated_at]) => ({
  id, title, is_finished, updated_at, cover: `https://fixture.invalid/poster/${id}`, tags: ["都市", "剧情"], score: 8.1,
  episode_count: id === 2 ? 10 : 12, total_episodes: id === 2 ? 10 : 12, hot: 1000, counts: { collect: 1, comment: 1, hot: 1, like: 1 },
  author: { id: 1, name: "作者" }, description: "fixture", episodes: [],
}));
let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  for (const candidate of ["/opt/browser/chrome", "/usr/local/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    if (!executablePath && await access(candidate).then(() => true, () => false)) executablePath = candidate;
  }
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36" });
  await context.addInitScript(installFixture, { theme: "dark", titles: rows.map(r => r.title) });
  await context.addInitScript(() => {
    const raw = JSON.parse(localStorage.getItem("hghubx_app_v1") || "{}");
    raw.favEpCounts = { 1: 10, 3: 12, 5: 12 };
    raw.history = [
      { id: 1, ep: 3, t: 55, dur: 180, at: 1 }, { id: 2, ep: 2, t: 10, dur: 180, at: 2 },
      { id: 3, ep: 12, t: 180, dur: 180, at: 3 }, { id: 4, ep: 12, t: 180, dur: 180, at: 4 },
      { id: 5, ep: 12, t: 180, dur: 180, at: 5 }, { id: 6, ep: 12, t: 180, dur: 180, at: 6 },
    ];
    localStorage.setItem("hghubx_app_v1", JSON.stringify(raw));
  });
  await context.addInitScript((details) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) =>
      command === "api_video" && details.find(row => row.id === args.id) || invoke(command, args);
  }, rows);
  const page = await context.newPage();
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
  await page.goto(new URL("/tests/ui-feedback.html", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page-body").waitFor();
  const filterButton = page.locator('[aria-label="收藏状态筛选"] button[aria-haspopup="menu"]');
  const menu = page.getByRole("menu", { name: "追剧状态" });
  const activeLabel = page.locator(".ios-filter-active-label");
  const openMenu = async () => {
    if (!(await menu.count())) await filterButton.click();
    await menu.waitFor();
  };
  const choose = async (name) => {
    await openMenu();
    await page.getByRole("menuitemradio", { name }).click();
    await menu.waitFor({ state: "detached" });
  };
  const backToAll = async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("hg:profile-reset")));
    await page.waitForFunction(() => document.querySelector('[aria-label="收藏状态筛选"] button')?.getAttribute("aria-pressed") === "false");
  };
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 6);
  await page.waitForFunction(() => document.querySelector('[aria-label="收藏状态筛选"] button')?.getAttribute("aria-expanded") === "false");
  const options = page.locator('.ios-filter-menu [role="menuitemradio"]');
  const optionTexts = async () => (await options.allInnerTexts()).map(text => text.replace(/\s+/g, " ").trim());
  await openMenu();
  assert.deepEqual(await optionTexts(), ["在追剧 2", "连载中 3", "已完结 3"]);
  assert.equal(await options.nth(0).getAttribute("aria-checked"), "false");
  assert.equal(await page.locator(".ios-filter-menu svg").count(), 0, "menu has no trailing check icon");
  const countRightEdges = await page.locator(".ios-filter-menu-count").evaluateAll(elements =>
    elements.map(element => Math.round(element.getBoundingClientRect().right)));
  assert.ok(Math.max(...countRightEdges) - Math.min(...countRightEdges) <= 1, "menu counts share one right edge");
  assert.equal(await page.locator('[aria-label="收藏内容类型"] button').first().innerText(), "短剧 6");
  const footer = page.locator('[role="status"]').filter({ hasText: "已显示" }).last();
  assert.equal(await footer.innerText(), "已显示 6 / 6 项本机记录");
  assert.equal(await page.locator(".ios-poster-badge.is-update").count(), 0, "all view never shows the blue unwatched badge");
  const [catBox, filterBox] = await Promise.all([
    page.locator('[aria-label="收藏内容类型"] button').first().boundingBox(), filterButton.boundingBox()]);
  assert.ok(catBox && filterBox && Math.abs(catBox.y - filterBox.y) <= 1 && Math.abs(catBox.height - filterBox.height) <= 1);
  assert.ok(filterBox.x + filterBox.width <= 390 - 16, "filter icon stays inside the page");
  const menuBox = await page.locator(".ios-filter-menu").boundingBox();
  assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, "menu stays inside the page");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-filter-menu.png", output)), animations: "disabled" });
  await page.getByRole("menuitemradio", { name: "在追剧 2" }).click();
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 2);
  assert.equal(await footer.innerText(), "已显示 2 / 2 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-title").allInnerTexts(), ["更新一", "完结二"]);
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["未看 9 集", "未看 8 集"]);
  assert.equal(await filterButton.getAttribute("aria-pressed"), "true");
  assert.equal(await activeLabel.innerText(), "在追剧 2");
  assert.ok(await filterButton.evaluate(el => el.classList.contains("is-labeled")), "active state expands the filter pill to include the label");
  assert.ok(await activeLabel.evaluate(el => el.parentElement === document.querySelector('[aria-label="收藏状态筛选"] button[aria-haspopup="menu"]')), "active label sits inside the filter pill");
  const activeFilterBox = await filterButton.boundingBox();
  assert.ok(activeFilterBox && catBox && Math.abs(activeFilterBox.height - catBox.height) <= 1, "active filter pill matches the category pill height");
  assert.ok(activeFilterBox.x + activeFilterBox.width <= 390 - 16, "expanded filter pill stays inside the page");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-unwatched.png", output)), animations: "disabled" });
  await openMenu();
  await filterButton.click();
  await menu.waitFor({ state: "detached" });
  assert.equal(await activeLabel.innerText(), "在追剧 2", "closing the menu must not reset the selected status");
  assert.equal(await filterButton.getAttribute("aria-pressed"), "true");
  await openMenu();
  await page.waitForFunction(() => document.activeElement?.closest('[role="menu"]') !== null);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await choose("连载中 3");
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 3);
  assert.equal(await footer.innerText(), "已显示 3 / 3 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-title").allInnerTexts(), ["更新一", "更新三", "更新五"]);
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["更新至 12 集", "更新至 12 集", "更新至 12 集"]);
  assert.equal(await activeLabel.innerText(), "连载中 3");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-ongoing.png", output)), animations: "disabled" });
  await openMenu();
  assert.equal(await page.getByRole("menuitemradio", { name: "连载中 3" }).getAttribute("aria-checked"), "true");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-filter-menu-selected.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  assert.equal(await footer.innerText(), "已显示 3 / 3 项本机记录");
  await choose("已完结 3");
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 3);
  assert.equal(await footer.innerText(), "已显示 3 / 3 项本机记录");
  assert.deepEqual(await page.locator(".ios-poster-title").allInnerTexts(), ["完结二", "完结四", "完结六"]);
  assert.deepEqual(await page.locator(".ios-poster-badge").allInnerTexts(), ["全 10 集", "全 12 集", "全 12 集"]);
  assert.equal(await activeLabel.innerText(), "已完结 3");
  await page.screenshot({ path: fileURLToPath(new URL("favorite-finished.png", output)), animations: "disabled" });
  await backToAll();
  await page.waitForFunction(() => document.querySelectorAll(".ios-poster-title").length === 6);
  assert.equal(await footer.innerText(), "已显示 6 / 6 项本机记录");
  assert.equal(await filterButton.getAttribute("aria-pressed"), "false");
  assert.equal(await activeLabel.count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL("favorite-default.png", output)), animations: "disabled" });
  console.log("PASS: category counts and footer totals stay consistent");
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await vite?.close();
}

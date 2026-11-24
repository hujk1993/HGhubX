import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../test-results/metric-sort/", import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  environment: "Real ChannelPage/TagPage in Chromium with mocked Tauri IPC",
  checks: [],
  errors: [],
};
const titles = ["甲", "乙", "丙"];
const metrics = [
  { hot: 3000, like_count: 10, collect_count: 200, score: 6 },
  { hot: 9000, like_count: 90, collect_count: 40, score: 8 },
  { hot: 5000, like_count: 50, collect_count: 150, score: 9 },
];
const expected = {
  点赞数: ["乙", "丙", "甲"],
  收藏数: ["甲", "丙", "乙"],
  播放数: ["乙", "丙", "甲"],
  评分: ["丙", "乙", "甲"],
  默认排序: ["甲", "乙", "丙"],
};
const expectedAsc = {
  点赞数: ["甲", "丙", "乙"],
  收藏数: ["乙", "丙", "甲"],
  播放数: ["甲", "丙", "乙"],
  评分: ["甲", "乙", "丙"],
};
let vite, browser;

try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
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
  await context.addInitScript(installFixture, { theme: "dark", titles, metrics, metricPages: 2, metricPageSize: 2 });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    return route.abort();
  });

  const cardTitles = () => page.locator(".ios-media-grid .ios-poster-title").allInnerTexts();
  const waitOrder = async values => {
    await page.waitForFunction(expected => {
      const actual = [...document.querySelectorAll(".ios-media-grid .ios-poster-title")].map(node => node.textContent);
      return JSON.stringify(actual) === JSON.stringify(expected);
    }, values);
    assert.deepEqual(await cardTitles(), values);
  };
  const openSortMenu = async () => {
    const menu = page.getByRole("menu", { name: "排序方式" });
    if (await menu.count()) return;
    await page.locator("[data-video-sort-trigger]").click();
    await menu.waitFor();
  };
  const selectSort = async label => {
    await openSortMenu();
    await page.getByRole("menuitemradio", { name: label, exact: true }).click();
    await waitOrder(expected[label]);
    assert.match(await page.locator("[data-video-sort-trigger]").innerText(), new RegExp(label));
  };
  const resetSort = async () => {
    await openSortMenu();
    await page.getByRole("menuitemradio", { name: "默认排序", exact: true }).click();
    await waitOrder(expected.默认排序);
    assert.equal((await page.locator("[data-video-sort-trigger]").innerText()).trim(), "");
    assert.equal(await page.getByRole("menu").count(), 0);
  };

  // Original channel: category pill row plus the metric sorter at the far right.
  await page.goto(new URL("/tests/channel-swipe.html?cate=original", origin).href, { waitUntil: "networkidle" });
  await page.locator(".ios-page > .scroll-y").waitFor();
  await page.locator("[data-video-sort-trigger]").waitFor();
  await waitOrder(expected.默认排序);
  await page.screenshot({ path: fileURLToPath(new URL("channel-default.png", output)), animations: "disabled" });
  await page.locator("[data-video-sort-trigger]").click();
  await page.getByRole("menu", { name: "排序方式" }).waitFor();
  assert.equal(await page.getByRole("menuitemradio", { name: "默认排序", exact: true }).count(), 1);
  assert.equal(await page.locator('[role="menuitemradio"][data-sort-direction="desc"]').count(), 4);
  await page.screenshot({ path: fileURLToPath(new URL("channel-menu.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  for (const label of ["点赞数", "收藏数", "播放数", "评分"]) {
    await selectSort(label);
    if (label === "点赞数") {
      await page.screenshot({ path: fileURLToPath(new URL("channel-like-sort.png", output)), animations: "disabled" });
      await openSortMenu();
      await page.getByRole("menuitemradio", { name: "点赞数", exact: true }).click();
      await waitOrder(expectedAsc.点赞数);
      assert.equal(await page.locator("[data-video-sort-trigger]").getAttribute("data-sort-direction"), "asc");
      assert.equal(await page.getByRole("menu", { name: "排序方式" }).count(), 1);
      await page.screenshot({ path: fileURLToPath(new URL("channel-like-asc.png", output)), animations: "disabled" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "原创漫剧", exact: true }).click();
      await waitOrder(expectedAsc.点赞数);
      assert.equal(await page.locator("[data-video-sort-trigger]").getAttribute("data-sort-direction"), "asc");
      report.checks.push("original channel: clicking the selected metric flips the arrow and keeps the menu open; switching tab keeps metric and direction");
      await page.getByRole("button", { name: "全部原创", exact: true }).click();
      await waitOrder(expectedAsc.点赞数);
    }
  }
  await resetSort();
  report.checks.push("original channel: all four metrics reorder globally; active pill is labeled; default menu item resets the order");

  // Tag results: the sorter sits on the "短剧 N" heading row and only changes videos.
  await page.goto(new URL("/tests/tag-metric-sort.html?tag=悬疑", origin).href, { waitUntil: "networkidle" });
  await page.locator("[data-video-sort-trigger]").waitFor();
  await waitOrder(expected.默认排序);
  await page.screenshot({ path: fileURLToPath(new URL("tag-default.png", output)), animations: "disabled" });
  await page.locator("[data-video-sort-trigger]").click();
  await page.getByRole("menu", { name: "排序方式" }).waitFor();
  assert.equal(await page.getByRole("menuitemradio", { name: "默认排序", exact: true }).count(), 1);
  await page.screenshot({ path: fileURLToPath(new URL("tag-menu.png", output)), animations: "disabled" });
  await page.keyboard.press("Escape");
  await selectSort("点赞数");
  await page.screenshot({ path: fileURLToPath(new URL("tag-like-sort.png", output)), animations: "disabled" });
  await selectSort("收藏数");
  await selectSort("播放数");
  await selectSort("评分");
  await openSortMenu();
  await page.getByRole("menuitemradio", { name: "评分", exact: true }).click();
  await waitOrder(expectedAsc.评分);
  assert.equal(await page.locator("[data-video-sort-trigger]").getAttribute("data-sort-direction"), "asc");
  await page.keyboard.press("Escape");
  await resetSort();
  report.checks.push("tag page: sorter is on the short-drama heading row; all four metrics reorder the video list and toggle direction");

  // Menu keyboard path: Escape closes and returns focus to the trigger.
  await page.locator("[data-video-sort-trigger]").focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menuitemradio", { name: "点赞数", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menuitemradio", { name: "点赞数", exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-video-sort-trigger")), true);
  report.checks.push("sort menu: ArrowDown opens; Escape closes and returns focus");

  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(`PASS: metric-sort (${report.checks.length} checks)`);
} catch (error) {
  report.failure = String(error?.stack || error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(fileURLToPath(new URL("report.json", output)), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
}

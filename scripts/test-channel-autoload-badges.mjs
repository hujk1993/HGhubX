// Local browser regression for poster corner badges (原创/热播/新片 + 72h expiry)
// and scroll auto-loading (including active tag filtering with 2-empty-page breaker).
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const svgCover = "https://fixture.invalid/cover.svg";
const svgBody = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#1e293b"/></svg>`;
const nowSec = Math.floor(Date.now() / 1000);

const makeCard = (id, opts = {}) => ({
  id,
  title: opts.title || `测试短剧 #${id}`,
  cover: svgCover,
  tags: opts.tags || ["都市", "逆袭"],
  score: opts.score ?? 8.7,
  episode_count: opts.ep ?? 14,
  total_episodes: opts.finished ? (opts.ep ?? 24) : 0,
  hot: opts.hot ?? 166000,
  like_count: 0,
  collect_count: 0,
  comment_count: 0,
  is_finished: Boolean(opts.finished),
  is_original: opts.original ? 1 : 0,
  is_hot: opts.isHot ? 1 : 0,
  new_at: opts.newAt ?? 0,
});

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

  const openChannel = async ({ viewport, blockedTags = [], pageData }) => {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(installFixture, { theme: "dark", titles: ["占位剧"] });
    await context.addInitScript(({ blockedTags, pageData }) => {
      localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
        version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
      }));
      localStorage.setItem("hghubx_auto_line", "0");
      if (blockedTags.length > 0) {
        localStorage.setItem("hghubx_content_preferences_v1", JSON.stringify({
          blockedTags, hideUntagged: false, paused: false,
        }));
      } else {
        localStorage.removeItem("hghubx_content_preferences_v1");
      }
      window.__channelCalls = [];
      const origInvoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
        window.__channelCalls.push({ cmd, args });
        if (cmd === "api_category") {
          const p = args.page || 1;
          const items = pageData[p] || [];
          return {
            items,
            pagination: { page: p, pages: Object.keys(pageData).length, size: items.length, total: 100 },
          };
        }
        if (cmd === "api_original_videos") {
          return { items: (pageData[1] || []).slice(0, 4), pagination: { page: 1, pages: 1, size: 4, total: 4 } };
        }
        return origInvoke(cmd, args);
      };
    }, { blockedTags, pageData });

    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on("pageerror", (error) => {
      const msg = String(error);
      if (!msg.includes("unregisterListener")) errors.push(msg);
    });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:") || new URL(url).origin === new URL(origin).origin) {
        return route.continue();
      }
      if (url.includes("/img?u=")) {
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: svgBody });
      }
      external.push(url);
      return route.abort();
    });

    await page.goto(origin);
    await page.getByRole("button", { name: "分类" }).first().click();
    await page.getByRole("button", { name: /AI成人短剧/ }).first().click();
    await page.locator(".ios-media-grid").waitFor({ state: "visible", timeout: 10000 });
    return { context, page, errors, external };
  };

  // 1. Poster badges (原创/热播/新片 + 72h expiry + no score overlap) & normal scroll auto-load
  {
    const p1 = [
      makeCard(101, { title: "全角标测试剧", original: true, isHot: true, newAt: nowSec - 3600, score: 9.4, ep: 12 }),
      makeCard(102, { title: "仅原创完结剧", original: true, finished: true, ep: 24, score: 8.8 }),
      makeCard(103, { title: "热播新片剧", isHot: true, newAt: nowSec - 7200, score: 8.5, ep: 6 }),
      makeCard(104, { title: "过期新片不显示", newAt: nowSec - 80 * 3600, score: 7.9, ep: 18 }),
      ...Array.from({ length: 16 }, (_, i) => makeCard(110 + i, { ep: i + 1, score: 8.0 })),
    ];
    const p2 = Array.from({ length: 20 }, (_, i) => makeCard(200 + i, { title: `第二页短剧 #${i + 1}` }));
    const { context, page, errors, external } = await openChannel({
      viewport: { width: 390, height: 844 },
      pageData: { 1: p1, 2: p2 },
    });

    const badgesOf = (title) => page.getByRole("button", { name: title }).locator(".ios-poster-flag").allInnerTexts();
    assert.deepEqual(await badgesOf("全角标测试剧"), ["原创", "热播", "新片"]);
    assert.deepEqual(await badgesOf("仅原创完结剧"), ["原创", "完结"]);
    assert.deepEqual(await badgesOf("热播新片剧"), ["热播", "新片"]);
    assert.deepEqual(await badgesOf("过期新片不显示"), []);
    assert.equal(await page.getByRole("button", { name: "仅原创完结剧" }).locator(".ios-poster-ep").innerText(), "已完结");

    const overlap = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll("button.ios-poster"))
        .find((b) => b.getAttribute("aria-label") === "全角标测试剧");
      const badges = card.querySelector(".ios-poster-badges").getBoundingClientRect();
      const score = card.querySelector(".ios-score-badge").getBoundingClientRect();
      return !(badges.right <= score.left + 1 || score.right <= badges.left + 1)
        && !(badges.bottom <= score.top + 1 || score.bottom <= badges.top + 1);
    });
    assert.equal(overlap, false, "Top-left badges must not overlap top-right score badge");
    assert.equal(await page.getByRole("button", { name: "加载更多", exact: true }).count(), 0);

    await page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll(".scroll-y")).pop();
      scroller.scrollTop = scroller.scrollHeight;
    });
    await page.getByText("第二页短剧 #1", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
    await page.getByText("— 已经到底啦 —").waitFor({ state: "visible", timeout: 5000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await context.close();
  }

  // 2. Active tag filtering keeps scroll auto-load and pauses after 2 consecutive empty filtered pages
  {
    const p1 = Array.from({ length: 16 }, (_, i) => makeCard(300 + i, { title: `可见剧 #${i + 1}`, tags: ["都市"] }));
    const p2 = Array.from({ length: 10 }, (_, i) => makeCard(400 + i, { title: `被屏蔽P2 #${i + 1}`, tags: ["职场"] }));
    const p3 = Array.from({ length: 10 }, (_, i) => makeCard(500 + i, { title: `被屏蔽P3 #${i + 1}`, tags: ["职场"] }));
    const p4 = [makeCard(601, { title: "第四页恢复可见剧", tags: ["都市"], original: true })];
    const { context, page, errors, external } = await openChannel({
      viewport: { width: 1100, height: 900 },
      blockedTags: ["职场"],
      pageData: { 1: p1, 2: p2, 3: p3, 4: p4 },
    });

    await page.evaluate(() => {
      const scroller = Array.from(document.querySelectorAll(".scroll-y")).pop();
      scroller.scrollTop = scroller.scrollHeight;
    });
    const loadMoreBtn = page.getByRole("button", { name: "加载更多", exact: true });
    await loadMoreBtn.waitFor({ state: "visible", timeout: 6000 });

    const fetched = await page.evaluate(() =>
      [...new Set(window.__channelCalls
        .filter((c) => c.cmd === "api_category" && c.args.cate === "ai-duanju" && c.args.size === 20)
        .map((c) => c.args.page))]
    );
    assert.deepEqual(fetched, [1, 2, 3], "Auto-load must stop after 2 consecutive fully-filtered pages");

    await loadMoreBtn.click();
    await page.getByText("第四页恢复可见剧", { exact: true }).waitFor({ state: "visible", timeout: 5000 });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await context.close();
  }

  console.log("PASS: channel poster badges, 72h expiry, normal scroll auto-load, and filtered 2-empty-page breaker");
} finally {
  await browser?.close();
  await vite?.close();
}

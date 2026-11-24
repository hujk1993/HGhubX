#!/usr/bin/env node
// Real Settings + App i18n regression in Chromium (mocked Tauri IPC, no upstream network):
//   1. Default locale is zh-CN (ignores navigator.language).
//   2. Switching to 繁體中文 / English in Settings updates UI immediately, updates <html lang>,
//      persists hghubx_locale in localStorage, and survives reload.
//   3. Switching back to 简体中文 restores Simplified Chinese cleanly.
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath) {
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
  }
}

let vite, browser;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const external = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(installFixture, { theme: "dark", titles: ["示例剧一"] });
  await context.addInitScript(() => {
    localStorage.setItem("hghubx_usage_agreement", JSON.stringify({
      version: "2026-11-15-v1", accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z",
    }));
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener() {} };
  });

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".hg-launch").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

  // 1. Default locale is zh-CN
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-CN");
  assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_locale")), null);

  // Open Settings -> Appearance section (open by default on desktop? click trigger if collapsed)
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  const appearanceBtn = page.locator("#settings-title-外观");
  if ((await appearanceBtn.getAttribute("aria-expanded")) !== "true") await appearanceBtn.click();

  // 2. Switch to 繁體中文
  await page.getByRole("button", { name: "繁體中文", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-Hant");
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_locale")), "zh-TW");

  // Reload and verify 繁體中文 persists
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".hg-launch").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.documentElement.lang === "zh-Hant");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("heading", { name: "設定", exact: true }).waitFor();
  if ((await appearanceBtn.getAttribute("aria-expanded")) !== "true") await appearanceBtn.click();

  // 3. Switch to English
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_locale")), "en");

  // Reload and verify English persists
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".hg-launch").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.documentElement.lang === "en");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  if ((await appearanceBtn.getAttribute("aria-expanded")) !== "true") await appearanceBtn.click();

  // 4. Switch back to 简体中文
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN");
  await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("hghubx_locale")), "zh-CN");
  assert.equal(external.length, 0, `Unexpected external requests: ${external.join(", ")}`);

  console.log("PASS: i18n defaults to zh-CN, switches zh-TW/en/zh-CN in Settings, and persists across reload");
  await context.close();
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
}

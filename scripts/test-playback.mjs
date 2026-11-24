// Local-only headless playback checks. No upstream APIs, credentials or Tauri IPC are used.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptScenarios = {
  tv: { script: "test-tv-remote.mjs", timeout: 480000, metrics: { transport: "mock Tauri IPC; actual TV bootstrap, worker, library and player" } },
  "post-flicker": { script: "test-post-flicker.mjs", timeout: 240000, metrics: { transport: "mock Tauri IPC; real PostDetail/AppProvider/Player; local HLS fixture" } },
};
const ALL_SCENARIOS = ["seek", "legacy", "lifecycle", "gesture", "proxy", "portrait-fit", "episode-toast", "ambient", "balance-volume", "ios-native", "recovery", "review", "tv", "post-flicker"];
const { values: args } = parseArgs({ options: {
  "media-dir": { type: "string" }, output: { type: "string" }, "browser-executable": { type: "string" },
  scenarios: { type: "string", default: "seek,legacy,lifecycle,gesture,proxy,portrait-fit" }, help: { type: "boolean" },
} });
if (args.help) {
  console.log(`pnpm test:playback [--media-dir DIR] [--output NEW_DIR] [--browser-executable PATH] [--scenarios all|${ALL_SCENARIOS.join(",")}]`);
  process.exit(0);
}
const scenarios = args.scenarios === "all" ? ALL_SCENARIOS : args.scenarios.split(",");
assert(scenarios.length && scenarios.every(s => ALL_SCENARIOS.includes(s)), "Unknown scenario");
const output = resolve(args.output || join(root, "test-results", "playback", new Date().toISOString().replace(/[:.]/g, "-")));
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // Refuse to overwrite artifacts from an earlier run.
const jsonl = (file, entry) => appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
const report = { started: new Date().toISOString(), platform: process.platform, browser: "chromium", transport: "browser fixture; not Tauri/WKWebView", output, cases: [] };
let temporaryMedia, temporaryPortraitMedia, vite, media, portraitMedia, browser;
let nextRequest = 0;
const requests = new Set();
// hls.js 的 worker/XHR 会直接请求 Linux 本机媒体代理；测试里统一映射到临时 fixture server。
const fixtureMediaOrigins = new Set(["http://127.0.0.1:17650", "http://hg.localhost"]);
const fixtureMediaUrl = raw => {
  const url = new URL(raw);
  return fixtureMediaOrigins.has(url.origin) ? new URL(`${url.pathname}${url.search}`, report.media).href : raw;
};

async function serveMedia(dir) {
  const manifest = await readFile(join(dir, "list.m3u8"), "utf8");
  assert(manifest.startsWith("#EXTM3U") && manifest.includes("#EXT-X-ENDLIST"), "Expected a local VOD HLS fixture");
  const server = createHttpServer(async (req, res) => {
    const started = performance.now(), request = ++nextRequest;
    const url = new URL(req.url, "http://localhost");
    let status = 200, bytes = 0, fragment;
    res.on("close", () => jsonl(join(output, "media-server.jsonl"), { request, route: url.pathname, fragment, status, bytes, elapsed_ms: Math.round(performance.now() - started), aborted: !res.writableFinished }));
    try {
      let body, kind;
      if (url.pathname === "/hls") {
        body = Buffer.from(manifest.split("\n").map(line => !line || line.startsWith("#") ? line :
          `http://hg.localhost/seg?u=${encodeURIComponent(`https://media.fixture.invalid/${line.trim()}`)}`).join("\n"));
        kind = "application/vnd.apple.mpegurl";
      } else if (url.pathname === "/seg") {
        fragment = basename(new URL(url.searchParams.get("u")).pathname);
        assert(/^seg\d+\.ts$/.test(fragment), "Unexpected fixture segment");
        await new Promise(done => setTimeout(done, 120));
        body = await readFile(join(dir, fragment)); kind = "video/mp2t";
      } else { status = 404; body = Buffer.from("not found"); kind = "text/plain"; }
      bytes = body.length;
      res.writeHead(status, { "Content-Type": kind, "Content-Length": bytes, "Access-Control-Allow-Origin": "*" });
      res.end(body);
    } catch {
      status = 404; res.writeHead(status); res.end("fixture error");
    }
  });
  server.on("connection", socket => { requests.add(socket); socket.on("close", () => requests.delete(socket)); });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return server;
}

const getLogs = page => page.evaluate(async () => { await window.playerSeekFixture.flushLogs(); return window.playerSeekFixture.logs; });
// 本地 VOD HLS fixture：testsrc2 + 正弦音轨。size 决定横屏（320x180）或竖屏（360x640）源。
const generateHlsFixture = (dir, size) => execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=15`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_filename", join(dir, "seg%03d.ts"), join(dir, "list.m3u8")], { timeout: 60000, stdio: "pipe" });
// Two steady tones about 36 dB apart: the audio graph must bring both to the same output RMS.
function balanceFixtureWav(seconds = 24, sampleRate = 22050) {
  const frames = sampleRate * seconds;
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0); data.writeUInt32LE(36 + frames * 2, 4); data.write("WAVE", 8);
  data.write("fmt ", 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22); data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const amplitude = i < sampleRate * 10 ? 0.012 : 0.8;
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return data.toString("base64");
}
async function waitLog(page, event, source) {
  await page.waitForFunction(({ event, source }) => window.playerSeekFixture.logs.some(e => e.event === event && (!source || e.data.source === source)), { event, source });
  return getLogs(page);
}
async function clickProgress(page, fraction) {
  const input = page.getByRole("slider", { name: "播放进度" });
  await input.scrollIntoViewIfNeeded();
  const r = await input.boundingBox(); assert(r, "Seekbar missing");
  await page.mouse.click(r.x + r.width * fraction, r.y + r.height / 2);
}
async function loadPlayer(page, legacy = false, extra = "") {
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}${extra}`);
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
}
async function balanceVolumeChecks(page) {
  // The fixture is seeded with balanceVolume enabled. The first gesture resumes
  // the shared AudioContext and attaches the media-element source exactly once.
  await page.addInitScript(() => {
    localStorage.setItem("hghubx_app_v1", JSON.stringify({ balanceVolume: true }));
    localStorage.setItem("hghubx_mobile_hold_guide_v1", "1");
  });
  await loadPlayer(page);
  await page.getByRole("button", { name: "取消静音", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("video")?.dataset.balanceVolume === "on", null, { timeout: 10000 });
  assert.equal(await page.locator("video").evaluate(video => video.dataset.balanceVolume), "on", "Balance volume must attach after the first user gesture");
  await page.evaluate(() => window.playerSeekFixture.setActive(false));
  await page.waitForFunction(() => document.querySelector("video")?.dataset.balanceVolume === "off");
  await page.evaluate(() => window.playerSeekFixture.setActive(true));
  await page.waitForFunction(() => document.querySelector("video")?.dataset.balanceVolume === "on");

  // Real graph check: a quiet tone and a loud tone must converge to the same output level.
  await page.goto(`${report.ui}/tests/balance-probe.html`);
  await page.waitForFunction(() => window.__balanceProbe);
  assert.equal(await page.evaluate(src => window.__balanceProbe.checkOpaqueGuard(src), `${report.media}/hls`), "unsupported",
    "Cross-origin non-CORS media must stay on native audio instead of producing silence");
  await page.evaluate(src => window.__balanceProbe.load(src), `data:audio/wav;base64,${balanceFixtureWav()}`);
  await page.click("#start");
  await page.waitForFunction(() => window.__balanceProbe.isStarted());
  await page.evaluate(() => window.__balanceProbe.seek(3));
  await page.waitForTimeout(4500);
  const quiet = await page.evaluate(() => window.__balanceProbe.metrics());
  await page.evaluate(() => window.__balanceProbe.seek(12));
  await page.waitForTimeout(4500);
  const loud = await page.evaluate(() => window.__balanceProbe.metrics());
  await page.evaluate(() => window.__balanceProbe.setVolume(0.2));
  await page.waitForTimeout(2500);
  const lowered = await page.evaluate(() => window.__balanceProbe.metrics());

  assert.equal(quiet.state, "on", "Probe graph must be active");
  assert.ok(quiet.outputDb > -22 && quiet.outputDb < -15, `Quiet tone output ${quiet.outputDb} dB is outside the leveling target`);
  assert.ok(Math.abs(loud.outputDb - quiet.outputDb) <= 1.5, `Quiet ${quiet.outputDb} dB and loud ${loud.outputDb} dB must converge within 1.5 dB`);
  assert.ok(quiet.desiredDb > 10, "Quiet source must receive substantial boost");
  assert.ok(loud.desiredDb < 0, "Loud source must be attenuated");
  assert.ok(quiet.outputPeakDb < -1.4 && loud.outputPeakDb < -1.4, "Output peaks must stay under the limiter ceiling");
  assert.ok(lowered.outputDb <= loud.outputDb - 12 && lowered.outputDb >= loud.outputDb - 17, `Manual volume must stay authoritative: ${loud.outputDb} -> ${lowered.outputDb}`);
  return {
    attached: true, state: "on",
    quiet_db: Math.round(quiet.outputDb * 10) / 10,
    loud_db: Math.round(loud.outputDb * 10) / 10,
    lowered_db: Math.round(lowered.outputDb * 10) / 10,
    quiet_gain_db: Math.round(quiet.desiredDb * 10) / 10,
    loud_gain_db: Math.round(loud.desiredDb * 10) / 10,
  };
}


async function speedMenuKeyboardChecks(page, paused) {
  const trigger = page.getByRole("button", { name: "倍速", exact: true });
  const menu = page.getByRole("menu", { name: "播放速度", exact: true });
  const assertFocus = async selector => {
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), selector);
  };
  const assertMediaState = async () => {
    assert.equal(await page.locator("video").evaluate(video => video.paused), paused, "Menu keys must preserve playback pause state");
  };
  const open = async key => {
    await trigger.focus();
    await page.keyboard.press(key);
    await menu.waitFor({ state: "visible" });
    await assertFocus('.player-speed-menu [aria-checked="true"]');
    await assertMediaState();
  };
  const assertSelection = async rate => {
    await page.waitForFunction(rate => document.querySelector("video").playbackRate === rate, rate);
    await menu.waitFor({ state: "detached" });
    await assertFocus(".player-speed");
    await assertMediaState();
  };

  // These keys reach the real Feed, so leaking Space would toggle the video.
  await open("Space");
  await page.keyboard.press("Home");
  await assertFocus('.player-speed-menu button:first-of-type');
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.locator(":focus").innerText(), "0.75x");
  await page.keyboard.press("End");
  await assertFocus('.player-speed-menu button:last-of-type');
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator(":focus").innerText(), "1.5x");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await assertSelection(2);

  await open("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await assertSelection(.75);

  await open("Space");
  await page.keyboard.press("Escape");
  await assertSelection(.75);

  await open("Enter");
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "detached" });
  await assertFocus(".player-volume > button");
  await assertMediaState();

  // Restore normal speed without mouse activation and preserve a useful focus.
  await open("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await assertSelection(1);
}
async function gestureChecks(page) {
  await page.addInitScript(() => {
    const { promise, resolve } = Promise.withResolvers();
    window.__playGate = promise;
    window.__releasePlay = resolve;
  });
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&swipe-ep=1&proxy=${encodeURIComponent(report.media)}`);
  const guide = page.getByRole("dialog", { name: "视频长按操作提示", exact: true });
  await guide.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("video")?.paused);
  await guide.getByRole("button", { name: "知道了", exact: true }).click();
  await guide.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1 && !document.querySelector("video").paused);
  const video = page.locator('video');
  const tap = () => page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    for (const type of ['pointerdown','pointerup']) surface.dispatchEvent(new PointerEvent(type, {
      bubbles:true, pointerId:91, pointerType:'touch', button:0, clientX:bounds.x+100, clientY:bounds.y+100,
    }));
  });
  const clean = () => page.locator('.player-root').getAttribute('data-clean');
  // Regression: after a double-tap pause, a single click on the center play icon resumes playback.
  await tap(); await tap();
  await page.waitForFunction(() => document.querySelector("video").paused);
  const centerPlay = page.getByRole("button", { name: "播放", exact: true });
  await centerPlay.waitFor();
  await centerPlay.click();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  assert.equal(await clean(), 'false', 'Center play icon must resume playback without another double tap');
  const start = Date.now();
  await tap();
  await page.waitForFunction(() => document.querySelector('.player-root')?.dataset.clean === 'true');
  const singleTapMs = Date.now()-start;
  assert(singleTapMs < 230, 'First tap must update before the old double-tap waiting window');
  await page.waitForTimeout(250);
  await tap();
  await page.waitForFunction(() => document.querySelector('.player-root')?.dataset.clean === 'false');
  await page.waitForTimeout(250);
  const wasPaused = await video.evaluate(v=>v.paused);
  await tap(); await tap();
  await page.waitForFunction(paused => document.querySelector('video').paused !== paused, wasPaused);
  assert.equal(await clean(), 'false', 'Double tap restores chrome and toggles playback once');
  await page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 80, clientY: bounds.y + 220 }));
    surface.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 220, clientY: bounds.y + 220 }));
  });
  await page.waitForFunction(() => document.querySelector('[data-seek-bar]')?.dataset.scrubbing === 'true');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.player-root *')].some(el => {
    const r = el.getBoundingClientRect();
    return r.top > 120 && r.bottom < 380 && el.textContent?.includes('/ 1:30');
  })), false, 'Horizontal gesture scrub must only highlight the bottom progress bar without a center-screen bar');
  await page.evaluate(() => {
    const surface = document.querySelector('video').parentElement.parentElement;
    const bounds = surface.getBoundingClientRect();
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 92, pointerType: 'touch', button: 0, clientX: bounds.x + 220, clientY: bounds.y + 220 }));
  });
  await page.waitForFunction(() => !document.querySelector('[data-seek-bar]')?.dataset.scrubbing);
  // 长按只保留临时加速；拖动到顶部胶囊锁定 2x 的旧交互必须消失。
  const holdBox = await page.locator('[data-mobile-hold-target]').first().boundingBox();
  assert(holdBox, 'Gesture surface must expose a hold target');
  const holdPoint = { x: holdBox.x + holdBox.width * .78, y: holdBox.y + holdBox.height * .28 };
  await page.evaluate(({ x, y }) => {
    const surface = document.querySelector('[data-mobile-hold-target]');
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 94, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }));
  }, holdPoint);
  await page.waitForFunction(() => document.querySelector('video')?.playbackRate > 1.5);
  assert.equal(await page.getByText(/移入此处锁定|松手即可锁定|已锁定 · 点按解除/).count(), 0,
    'Speed-lock capsule and its prompts must be removed');
  await page.evaluate(({ x, y }) => {
    const surface = document.querySelector('[data-mobile-hold-target]');
    surface.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 94, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0, clientX: x, clientY: y }));
  }, holdPoint);
  await page.waitForFunction(() => document.querySelector('video')?.playbackRate === 1);
  // 2.2.0 反馈回归：切集过渡期（下一集地址未解析）手势 overlay 必须常驻。
  // 修复前第二划落在卸载后的封面/滚动列表上被丢弃或切到别的视频；修复后集数连加且视频不变。
  await page.evaluate(() => window.playerSeekFixture.setLogging(true));
  const swipeUp = () => page.evaluate(() => {
    const surface = document.querySelector('[data-mobile-hold-target]') || document.querySelector('.player-root section');
    const b = surface.getBoundingClientRect();
    const x = b.x + b.width / 2, y0 = b.y + b.height * .7, y1 = b.y + b.height * .3;
    const at = y => ({ bubbles: true, pointerId: 92, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(y0)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(y1)));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...at(y1), buttons: 0 }));
  });
  await swipeUp();
  await page.locator('.mobile-video-episode').filter({ hasText: /^第2集$/ }).first().waitFor();
  await swipeUp();
  await page.locator('.mobile-video-episode').filter({ hasText: /^第3集$/ }).first().waitFor();
  await page.evaluate(() => window.__releasePlay());
  await page.waitForFunction(() => window.playerSeekFixture.logs.some(e => e.event === 'play.resolve' && e.data.video_id === 991 && e.data.episode === 3));
  assert.equal(await page.evaluate(() => window.playerSeekFixture.logs.some(e => e.event === 'play.resolve' && e.data.video_id === 992)), false,
    'Fast episode swipes must stay on the same video');
  const swipeToggle = page.locator('button.mobile-playback-quick[aria-label*="上下划切集"]').first();
  for (let i = 0; i < 3; i++) {
    await swipeToggle.click();
    await page.waitForTimeout(80);
  }
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 1);
  assert.equal(await page.locator(".a-toast").count(), 1, "Rapid swipe-toggle taps must keep one toast card");
  assert.match(await page.locator(".a-toast").innerText(), /上下划切集/);
  return { singleTapMs, bottomOnlyScrub: true, temporaryHoldRestored: 1, fastSwipeEpisodes: [2, 3], sameVideo: true, swipeToggleToastCards: 1 };
}

// issue #142 回归：手机竖屏视口 + 真实竖屏源（360x640，高>宽）。
// fit 判定只认解码后的 videoWidth/videoHeight（VideoSurface onSize → Feed vsize），
// 所以必须等真实元数据落地后再断言 computed object-fit：
//   修复前：landscapeVideo=false 且已测量、非全屏、vpLandscape=false → "cover"（裁切铺满）→ 断言失败；
//   修复后：竖屏视频一律 "contain"（保留原始比例）→ 断言通过。
// 第二段用横屏源验证「铺满/适应」切换链路未被修复破坏（该分支修复前后行为一致）。
// Switching episodes within the same landscape series in fullscreen must keep
// .fs-landscape active and keep episode/boundary hints anchored at the landscape
// bottom on every frame — including while distinct episode URLs are loading.
async function episodeToastChecks(page, dir) {
  await page.addInitScript(() => {
    const g2 = Promise.withResolvers();
    const g3 = Promise.withResolvers();
    window.__playGates = { 2: g2.promise, 3: g3.promise };
    window.__releaseEp = ep => (ep === 2 ? g2.resolve() : ep === 3 ? g3.resolve() : undefined);
    window.__TAURI_INTERNALS__ = { invoke: async () => null };
  });
  await page.goto(`${report.ui}/tests/player-seek.html?portrait-fit=1&swipe-ep=1&proxy=${encodeURIComponent(report.media)}`);
  const dismissGuide = async () => {
    const done = page.locator(".mobile-hold-guide-done").first();
    await done.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await done.click({ timeout: 5000 }).catch(() => {});
  };
  const waitForPlayback = () => page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 320 && v.videoHeight === 180 && v.currentTime > .2 && !v.paused;
  });
  const assertRotatedBottom = async toast => {
    const [box, viewport] = await Promise.all([toast.boundingBox(), page.evaluate(() => ({ w: innerWidth, h: innerHeight }))]);
    assert(box, "Rotated hint must be measurable");
    // .fs-landscape rotates +90deg clockwise around center: local bottom:96px (upright
    // bottom center of the landscape video) maps to the left side of the 390x844 portrait
    // viewport, horizontally centered along the landscape video width (portrait Y axis).
    assert(box.x < viewport.w / 2 && box.height > box.width, "Rotated hint must sit at the landscape video bottom (#181)");
    assert(Math.abs((box.y + box.height / 2) - viewport.h / 2) < 24, "Rotated hint must be centered along the landscape video");
    assert(await toast.evaluate(el => !!el.closest(".player-root.fs-landscape")), "Rotated hint must stay inside the rotated stage");
  };
  const swipeNext = pointerId => page.evaluate(id => {
    const surface = document.querySelector("[data-mobile-hold-target]");
    const box = surface.getBoundingClientRect();
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width * .3, x1 = box.x + box.width * .7;
    surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: id, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x0, clientY: y }));
    surface.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: id, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x1, clientY: y }));
    surface.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: id, pointerType: "touch", isPrimary: true, button: 0, buttons: 0, clientX: x1, clientY: y }));
  }, pointerId);

  await dismissGuide();
  await waitForPlayback();

  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".player-root")?.classList.contains("fs-landscape"));
  assert.equal(await page.locator(".mobile-video-episode").count(), 0, "Fullscreen must not render the portrait episode badge");

  // Double-tap pause must expose the current episode in the same playback-hint
  // toast slot used by episode swipes, and keep it mounted while the center
  // play/pause affordance is visible. Resuming must remove it immediately.
  const tapCenter = () => page.evaluate(() => {
    const surface = document.querySelector("[data-mobile-hold-target]");
    const box = surface.getBoundingClientRect();
    const at = { bubbles: true, pointerId: 130, pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    surface.dispatchEvent(new PointerEvent("pointerdown", at));
    surface.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
  });
  await tapCenter();
  await tapCenter();
  await page.waitForFunction(() => document.querySelector("video")?.paused);
  const pauseHint = page.locator(".a-toast").filter({ hasText: /第 1 ?集 \/ 3/ });
  await pauseHint.waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".a-toast").count(), 1, "Pause hint must occupy the single playback-hint slot");
  await assertRotatedBottom(pauseHint);
  await page.waitForTimeout(2400);
  assert.equal(await page.locator(".a-toast").count(), 1, "Pause hint must outlive the normal toast TTL while paused");
  const pauseHintText = (await pauseHint.innerText()).trim();
  await page.screenshot({ path: join(dir, "pause-episode-hint.png") });
  await page.getByRole("button", { name: "播放", exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector("video")?.paused);
  await page.waitForFunction(() => document.querySelectorAll(".a-toast").length === 0);
  assert.equal(await pauseHint.count(), 0, "Resuming playback must dismiss the pause hint with the center affordance");

  // Continuously observe DOM mutations + animation frames while in landscape fullscreen:
  // neither the rotated stage nor any visible toast may ever drop to portrait coordinates.
  await page.evaluate(() => {
    const audit = { active: true, stageDropped: 0, portraitToasts: [] };
    const sample = () => {
      if (!audit.active) return;
      const root = document.querySelector(".player-root");
      if (!root || !root.classList.contains("fs-landscape")) audit.stageDropped += 1;
      for (const el of document.querySelectorAll(".a-toast")) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const inRotated = !!el.closest(".player-root.fs-landscape");
        const rotatedShape = rect.left < innerWidth / 2 && rect.height > rect.width;
        if (!inRotated || !rotatedShape) {
          audit.portraitToasts.push({ text: (el.textContent || "").trim(), inRotated, x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    const tick = () => { sample(); if (audit.active) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__stopLandscapeAudit = () => { audit.active = false; observer.disconnect(); return audit; };
  });

  // Swipe 1 (Ep 1 -> Ep 2, gated): rotated stage stays active while Ep 2 loads and toast sits at landscape bottom.
  const ep2Toast = page.locator(".a-toast").filter({ hasText: /第 2 ?集 \/ 3/ });
  await swipeNext(120);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => !!document.querySelector(".player-root.fs-landscape")), true, "Landscape stage must not drop .fs-landscape while next episode loads");
  await ep2Toast.waitFor({ timeout: 3000 });
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".a-toast").count(), 1, "Episode 2 hint must appear in landscape bottom without stacking");
  await assertRotatedBottom(ep2Toast);
  await page.evaluate(() => window.__releaseEp(2));
  await waitForPlayback();
  await assertRotatedBottom(ep2Toast);

  // Swipe 2 (Ep 2 -> Ep 3 while Ep 2 toast is still mounted and Ep 3 is gated):
  // neither the existing toast nor the incoming Ep 3 toast may flash in portrait.
  const ep3Toast = page.locator(".a-toast").filter({ hasText: /第 3 ?集 \/ 3/ });
  await swipeNext(121);
  await ep3Toast.waitFor({ timeout: 3000 });
  await page.waitForTimeout(250);
  assert.equal(await page.locator(".a-toast").count(), 1, "Next episode hint must replace in-place");
  await assertRotatedBottom(ep3Toast);

  // Boundary swipe while Ep 3 is still loading (gated) must also replace in-place at landscape bottom.
  await swipeNext(123);
  const lastToast = page.locator(".a-toast").filter({ hasText: /当前已是最后一集/ });
  await lastToast.waitFor({ timeout: 3000 });
  assert.equal(await page.locator(".a-toast").count(), 1, "Boundary hint must replace the episode hint instead of stacking");
  await assertRotatedBottom(lastToast);
  await page.evaluate(() => window.__releaseEp(3));
  await waitForPlayback();
  await assertRotatedBottom(lastToast);

  const audit = await page.evaluate(() => window.__stopLandscapeAudit());
  assert.equal(audit.stageDropped, 0, `Landscape stage dropped .fs-landscape during episode switches (${audit.stageDropped} times)`);
  assert.deepEqual(audit.portraitToasts, [], `Toast flashed at portrait position during landscape episode switches: ${JSON.stringify(audit.portraitToasts)}`);
  const lastBox = await lastToast.boundingBox();

  // Exiting fullscreen while a toast is visible must immediately move ToastHost back to the portrait viewport
  // without waiting for another toast event.
  await swipeNext(124);
  await lastToast.waitFor({ timeout: 3000 });
  const exitBtn = page.getByRole("button", { name: "退出全屏", exact: true });
  if (await exitBtn.count() === 0) {
    await page.locator("[data-mobile-hold-target]").click();
    await exitBtn.waitFor({ timeout: 3000 });
  }
  await exitBtn.click();
  await page.waitForFunction(() => !document.querySelector(".player-root")?.classList.contains("fs-landscape"));
  const portraitAfterExit = await page.evaluate(() => {
    const el = document.querySelector(".a-toast");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { inPlayerRoot: !!el.closest(".player-root"), w: rect.width, h: rect.height, y: rect.top, vh: innerHeight };
  });
  assert(portraitAfterExit, "Active toast must still be visible right after exiting fullscreen");
  assert.equal(portraitAfterExit.inPlayerRoot, false, "Exiting fullscreen must move active ToastHost out of .player-root");
  assert(portraitAfterExit.w > portraitAfterExit.h && portraitAfterExit.y > portraitAfterExit.vh / 2, "Toast after exiting fullscreen must sit horizontally at portrait bottom");
  return { stageDropped: audit.stageDropped, portraitFlashes: audit.portraitToasts.length, boundaryReplaces: true, rotatedBottom: true, noPortraitEpisodeBadge: true, host: "rotated-stage", pauseHint: { text: pauseHintText, sticky: true, dismissOnResume: true, rotatedBottom: true }, text: (await lastToast.innerText().catch(() => "当前已是最后一集")).trim(), box: lastBox, portraitAfterExit };
}

// Ambient glow is a sampled color wash behind the video. It must follow the
// live setting, render on a readable source, and leave no layer when disabled.
async function ambientGlowChecks(page) {
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: async () => null };
  });
  const open = () => page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&portrait-fit=1&proxy=${encodeURIComponent(report.portraitMedia)}`);
  const dismissGuide = async () => {
    const done = page.locator(".mobile-hold-guide-done").first();
    await done.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await done.click({ timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector(".mobile-hold-guide-done"), null, { timeout: 5000 }).catch(() => {});
  };
  const waitForPlayback = () => page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 360 && v.videoHeight === 640 && v.currentTime > 1 && !v.paused;
  });
  const openSettingsPage = async () => {
    await page.getByRole("button", { name: "诊断设置", exact: true }).click();
    const settings = page.locator(".ios-settings-page");
    await settings.waitFor({ state: "visible" });
    await settings.getByRole("button", { name: "播放设置", exact: true }).click();
    await page.waitForFunction(() => {
      const panel = document.querySelector("#settings-播放");
      return panel && !panel.querySelector("[hidden]");
    });
    return settings;
  };
  const closeSettingsPage = async (settings) => {
    await settings.getByRole("button", { name: "返回", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
  };
  const persistedAmbient = () => page.evaluate(() => JSON.parse(localStorage.getItem("hghubx_app_v1") || "{}").ambientGlow);

  await open();
  await dismissGuide();
  await waitForPlayback();
  await page.waitForFunction(() => Number(document.querySelector(".hg-ambient-glow-canvas")?.dataset.frames || 0) > 0);
  const on = await page.evaluate(() => ({
    layers: document.querySelectorAll(".hg-ambient-glow").length,
    frames: Number(document.querySelector(".hg-ambient-glow-canvas")?.dataset.frames || 0),
    canvas: !!document.querySelector(".hg-ambient-glow-canvas"),
  }));
  assert.equal(on.layers, 1, "Ambient glow must render by default");
  assert.equal(on.canvas, true, "Ambient glow needs a sample canvas");
  assert(on.frames > 0, "Ambient glow must sample the playing video");

  const settings = await openSettingsPage();
  const glow = settings.getByRole("switch", { name: "微光效果", exact: true });
  const hevc = settings.getByRole("switch", { name: "优先高清", exact: true });
  const [glowBox, hevcBox] = await Promise.all([glow.boundingBox(), hevc.boundingBox()]);
  assert(glowBox && hevcBox, "Both playback toggles must occupy a real box");
  assert(Math.abs(glowBox.x - hevcBox.x) <= 1, "Ambient glow toggle must right-align with the priority-HD toggle");
  assert(Math.abs(glowBox.width - hevcBox.width) <= 1 && Math.abs(glowBox.height - hevcBox.height) <= 1,
    "Ambient glow toggle must match the priority-HD toggle size");
  assert.equal(await glow.getAttribute("aria-checked"), "true", "Settings page must reflect the persisted ambient glow setting");
  await glow.click();
  await page.waitForFunction(() => document.querySelectorAll(".hg-ambient-glow").length === 0);
  assert.equal(await glow.getAttribute("aria-checked"), "false", "Settings page switch must disable ambient glow");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("hghubx_app_v1") || "{}").ambientGlow === false);
  await closeSettingsPage(settings);

  await page.getByRole("button", { name: "更多播放设置", exact: true }).click();
  const more = page.getByRole("dialog", { name: "播放设置", exact: true });
  await more.waitFor({ state: "visible" });
  assert.equal(await more.getByRole("switch", { name: "微光效果", exact: true }).count(), 0,
    "Ambient glow must not appear in the More playback panel");
  await more.getByRole("button", { name: "关闭播放设置", exact: true }).click();
  await more.waitFor({ state: "hidden" });

  await page.reload();
  await dismissGuide();
  await waitForPlayback();
  const off = await page.evaluate(() => ({
    layers: document.querySelectorAll(".hg-ambient-glow").length,
    persisted: JSON.parse(localStorage.getItem("hghubx_app_v1") || "{}").ambientGlow,
  }));
  assert.equal(off.layers, 0, "Disabling ambient glow must remove the layer");
  assert.equal(off.persisted, false, "Ambient glow preference must persist");

  const settingsAfterReload = await openSettingsPage();
  const glowAfterReload = settingsAfterReload.getByRole("switch", { name: "微光效果", exact: true });
  assert.equal(await glowAfterReload.getAttribute("aria-checked"), "false", "Settings page must restore the disabled state");
  await glowAfterReload.click();
  await page.waitForFunction(() => document.querySelectorAll(".hg-ambient-glow").length === 1);
  assert.equal(await persistedAmbient(), true, "Settings page switch must persist re-enabling");
  return { defaultOn: true, sampledFrames: on.frames, offLayers: off.layers, settingsToggle: true, morePanelToggle: false };
}

async function portraitFitChecks(page, dir) {
  // The mobile fullscreen transition asks Tauri to lock the screen orientation.
  // This scenario runs in Chromium, so provide only that bridge and keep the
  // rest of the playback stack real.
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: async () => null };
  });
  const open = proxy => page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&portrait-fit=1&proxy=${encodeURIComponent(proxy)}`);
  // onSize 是原生媒体事件里的 React 更新；双 rAF 保证 setVsize 已提交到 DOM（帧同步，非任意 sleep）。
  const afterCommit = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined)))));
  const objectFit = () => page.locator("video").evaluate(v => getComputedStyle(v).objectFit);

  await open(report.portraitMedia);
  const guide = page.getByRole("dialog", { name: "视频长按操作提示", exact: true });
  await guide.waitFor({ state: "visible" });
  await guide.getByRole("button", { name: "知道了", exact: true }).click();
  await guide.waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 360 && v.videoHeight === 640 && v.currentTime > 1 && !v.paused;
  });
  await afterCommit();
  const portrait = await page.locator("video").evaluate(v => ({
    objectFit: getComputedStyle(v).objectFit, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
  }));
  assert(portrait.videoHeight > portrait.videoWidth, "Fixture must decode a portrait source (h > w) to reach the portrait branch");
  assert.equal(portrait.objectFit, "contain", "Portrait video must keep its original aspect ratio (issue #142), not crop with object-cover");
  // 「铺满」按钮只在 landscapeVideo=true 时渲染；它不存在证明确实走了竖屏分支。
  assert.equal(await page.getByRole("button", { name: "铺满", exact: true }).count(), 0, "Portrait source must not offer the landscape fill toggle");

  // 同一手机竖屏视口换横屏源（320x180）：默认 contain，铺满→cover，适应→contain。
  await open(report.media);
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth === 320 && v.videoHeight === 180 && v.currentTime > 1 && !v.paused;
  });
  await afterCommit();
  assert.equal(await objectFit(), "contain", "Landscape video in a portrait viewport must default to contain");
  assert.equal(await page.getByRole("button", { name: "铺满", exact: true }).count(), 0, "Floating fill control must be removed");
  assert.equal(await page.getByRole("button", { name: "横屏", exact: true }).count(), 0, "Floating rotate control must be removed");
  await page.getByRole("button", { name: "更多播放设置" }).click();
  await page.getByRole("dialog", { name: "播放设置" }).waitFor();
  await page.getByRole("button", { name: "铺满", exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("video")).objectFit === "cover");
  await page.getByRole("button", { name: "适应", exact: true }).click();
  await page.waitForFunction(() => getComputedStyle(document.querySelector("video")).objectFit === "contain");
  // PR #177 removes the floating fill/rotate controls, so this regression must
  // enter fullscreen through the persistent bottom-dock control. Close its
  // settings sheet first so the same case also runs after that PR lands.
  const settingsDialog = page.getByRole("dialog", { name: "播放设置", exact: true });
  if (await settingsDialog.count()) {
    await settingsDialog.getByRole("button", { name: "关闭播放设置", exact: true }).click();
    await settingsDialog.waitFor({ state: "hidden" });
  }

  // Rotated landscape fullscreen: the lock entry and the shutdown unlock
  // must occupy the same stage-local anchor even when the phone has a bottom
  // safe-area inset. The rotated stage maps --sab to its right edge.
  await page.locator(".player-root").evaluate(el => {
    el.style.setProperty("--sab", "34px");
    el.style.setProperty("--sar", "0px");
    el.style.setProperty("--sal", "0px");
    el.style.setProperty("--sat", "44px");
  });
  await page.getByRole("button", { name: "全屏", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".player-root")?.classList.contains("fs-landscape"));
  await page.waitForTimeout(250);
  const qualityBox = await page.locator(".feed-current-quality").boundingBox();
  assert(qualityBox, "Quality indicator must be visible with the fullscreen controls");
  const cleanLock = page.getByRole("button", { name: "锁定屏幕", exact: true });
  await cleanLock.waitFor();
  const cleanBox = await cleanLock.boundingBox();
  await cleanLock.click();
  const unlock = page.getByRole("button", { name: "解锁屏幕", exact: true });
  await page.getByText("已锁定屏幕", { exact: true }).waitFor();
  assert.equal(await page.locator(".mobile-clean-lock").count(), 0, "Locking must hide the clean lock icon");
  assert.equal(await unlock.count(), 0, "Unlock control must stay hidden until the first tap");
  assert.equal(await page.locator(".a-toast").count(), 1, "Locking must show exactly one status toast");
  await page.screenshot({ path: join(dir, "lock-hidden.png") });
  // Rapid taps on the shield only refresh the same screen-lock toast; they must not stack cards.
  for (let i = 0; i < 5; i += 1) await page.mouse.click(40, 120);
  await unlock.waitFor();
  await page.getByText("轻触即可解锁", { exact: true }).waitFor();
  assert.equal(await page.locator(".a-toast").count(), 1, "Repeated locked-area taps must keep one toast");
  await page.screenshot({ path: join(dir, "unlock-revealed.png") });
  await page.waitForTimeout(2300);
  assert.equal(await unlock.count(), 0, "Unlock control must hide with the screen-lock hint");
  assert.equal(await page.locator(".a-toast").count(), 0, "Screen-lock hint must expire with the unlock control");
  await page.mouse.click(40, 120);
  await unlock.waitFor();
  const unlockBox = await unlock.boundingBox();
  assert(cleanBox && unlockBox, "Both the clean lock and unlock controls must be measurable");
  const anchorDelta = Math.hypot(cleanBox.x - unlockBox.x, cleanBox.y - unlockBox.y);
  assert(anchorDelta < 1, `Clean lock must keep the unlock anchor in rotated fullscreen (delta ${anchorDelta.toFixed(1)}px)`);
  const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  const cleanCenter = center(cleanBox), qualityCenter = center(qualityBox);
  // After the 90-degree stage rotation, stage Y is the upright X axis.
  const qualityAlignDelta = Math.abs(cleanCenter.y - qualityCenter.y);
  assert(qualityAlignDelta < 1, `Lock and quality indicator must share the upright right edge (delta ${qualityAlignDelta.toFixed(1)}px)`);
  await unlock.click();
  await page.getByText("已解锁", { exact: true }).waitFor();
  await unlock.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".a-toast").count(), 1, "Unlocking must replace the hint instead of stacking");
  assert.equal(await page.getByRole("button", { name: "锁定屏幕", exact: true }).count(), 1, "Unlock restores the fullscreen controls and their lock entry");
  return { viewport: "390x844", portrait_source: "360x640", portrait_object_fit: portrait.objectFit,
    landscape_default_fit: "contain", landscape_toggle: ["contain", "cover", "contain"], floating_fit_rotate: 0 };
}

async function seekChecks(page, legacy) {
  await loadPlayer(page, legacy);
  await clickProgress(page, .1);
  assert.equal((await getLogs(page)).length, 0, "Default-off must not record seeks");
  await page.getByRole("button", { name: "诊断设置", exact: true }).click();
  const diagnostics = page.getByRole("button", { name: "播放诊断设置", exact: true });
  assert.equal(await diagnostics.getAttribute("aria-expanded"), "false");
  await diagnostics.click();
  assert.equal(await diagnostics.getAttribute("aria-expanded"), "true");
  await page.getByRole("switch", { name: "播放诊断日志", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="播放诊断日志"]').getAttribute("aria-checked") === "true");
  await page.getByRole("button", { name: "诊断设置", exact: true }).click();
  await clickProgress(page, .8);
  let logs = await waitLog(page, "seek.resumed");
  const first = logs.find(e => e.event === "seek.request" && e.data.source === `${legacy ? "legacy" : "desktop"}_click`);
  assert(first, "Actual click must request a seek");
  for (const event of ["seek.input.down", "seek.input.change", "seek.input.up", "seek.assigned", "media.seeking", "media.seeked"]) assert(logs.some(e => e.event === event), event);
  assert(logs.some(e => e.event === "seek.resumed" && e.data.seek === first.data.seek), "Click must recover a frame with matching seek ID");

  const before = logs.length;
  const r = await page.getByRole("slider", { name: "播放进度" }).boundingBox();
  const current = await page.locator("video").evaluate(v => v.currentTime / v.duration);
  await page.mouse.move(r.x + r.width * current, r.y + r.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(r.x + r.width * (current + (.45 - current) * i / 12), r.y + r.height / 2);
    await page.waitForTimeout(30);
  }
  const duringDrag = (await getLogs(page)).slice(before);
  assert.equal(duringDrag.filter(e => e.event === "seek.request").length, 0, "Pointer movement must only preview, without seeking");
  assert(duringDrag.filter(e => e.event === "seek.input.change" && e.data.input === "drag").length > 1, "Drag must keep logging preview positions");
  const preview = await page.getByRole("slider", { name: "播放进度" }).inputValue();
  assert(Math.abs(Number(preview) - 40.5) < .5, "Seekbar must preview the target before release");
  await page.mouse.up();
  await page.waitForFunction(n => window.playerSeekFixture.logs.slice(n).some(e => e.event === "seek.resumed"), before);
  logs = (await getLogs(page)).slice(before);
  const drags = logs.filter(e => e.event === "seek.request" && e.data.source === `${legacy ? "legacy" : "desktop"}_drag`);
  assert.equal(drags.length, 1, "A whole drag must commit exactly one seek on release");
  const last = drags.at(-1);
  assert(logs.some(e => e.event === "seek.input.up" && e.data.input === "drag"));
  assert(logs.some(e => e.event === "seek.resumed" && e.data.seek === last.data.seek), "Final drag target must recover a frame");
  const fragments = (await getLogs(page)).filter(e => e.event === "hlsFragLoading" || e.event === "hlsFragLoaded");
  assert(fragments.some(e => e.event === "hlsFragLoading" && e.data.load_ms === null), "Incomplete downloads must have unknown duration");
  for (const { data } of fragments) {
    for (const key of ["load_ms", "first_byte_ms"]) {
      assert(data[key] === null || data[key] >= 0, "Fragment timings must never be negative");
    }
  }

  if (!legacy) await speedMenuKeyboardChecks(page, false);

  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await clickProgress(page, .6);
  logs = await waitLog(page, "seek.ready");
  assert(await page.locator("video").evaluate(v => v.paused), "Paused seek must stay paused");
  const keyboardBefore = logs.length;
  await page.getByRole("slider", { name: "播放进度" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(n => window.playerSeekFixture.logs.slice(n).some(e => e.event === "seek.ready"), keyboardBefore);
  assert((await getLogs(page)).slice(keyboardBefore).some(e => e.event === "seek.request" && e.data.source.endsWith("_keyboard")), "Native keyboard seek must still work");
  assert(await page.locator("video").evaluate(v => v.paused), "Keyboard seek must preserve pause");
  if (!legacy) await speedMenuKeyboardChecks(page, true);

  // Page changes during capture must cancel the preview rather than seek the hidden player.
  const cancelledBefore = (await getLogs(page)).length;
  const cancelBox = await page.getByRole("slider", { name: "播放进度" }).boundingBox();
  await page.mouse.move(cancelBox.x + cancelBox.width * .3, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBox.x + cancelBox.width * .7, cancelBox.y + cancelBox.height / 2);
  await page.evaluate(() => window.playerSeekFixture.setActive(false));
  await page.waitForFunction(() => document.querySelector('input[aria-label="播放进度"]').disabled);
  await page.mouse.up();
  const cancelled = (await getLogs(page)).slice(cancelledBefore);
  assert(cancelled.some(e => e.event === "seek.input.cancel"), "Deactivation must cancel the drag");
  assert(!cancelled.some(e => e.event === "seek.request"), "Cancelled drag must not commit a seek");
  await page.evaluate(() => window.playerSeekFixture.setActive(true));
  await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
  assert(await page.locator("video").evaluate(v => v.paused), "Returning must preserve manual pause");
  await page.evaluate(() => window.playerSeekFixture.setLogging(false));
  const count = (await getLogs(page)).length;
  await clickProgress(page, .2); await page.waitForTimeout(350);
  assert.equal((await getLogs(page)).length, count, "Disabled logging must stop recording");
  await page.evaluate(() => { window.playerSeekFixture.rejectLoggingSave = true; });
  const rejected = await page.evaluate(() => window.playerSeekFixture.setLogging(true).then(() => false, () => true));
  assert(rejected, "Failed persistence must reject");
  await clickProgress(page, .3);
  assert.equal((await getLogs(page)).length, count, "Failed persistence must keep logging disabled");
  if (!legacy) {
    // Desktop swipeEp regression: wheel scrolling over the feed player must switch episodes
    // when swipeEp is enabled instead of scrolling boxRef to the next drama, and bottom-bar
    // Next must follow swipeEp when toggled off.
    await loadPlayer(page, false, "&swipe-ep=1");
    const activeMeta = page.locator("section:not([inert]) .desktop-video-meta");
    const epBadge = activeMeta.getByText(/^第 \d+\/3 集$/);
    await epBadge.waitFor();
    assert.equal(await epBadge.innerText(), "第 1/3 集");
    const swipeBtn = page.getByRole("button", { name: "上下划切集", exact: true });
    assert.equal(await swipeBtn.getAttribute("aria-pressed"), "true");
    const rootBox = await page.locator(".player-root").boundingBox();
    await page.mouse.move(rootBox.x + rootBox.width / 2, rootBox.y + rootBox.height / 2);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => document.querySelector("section:not([inert]) .desktop-video-meta")?.textContent?.includes("第 2/3 集"));
    assert.equal(await activeMeta.locator("p").first().innerText(), "Seek fixture");
    await page.getByText("第 2集 / 3", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(() => document.querySelector("section:not([inert]) .desktop-video-meta")?.textContent?.includes("第 1/3 集"));
    await swipeBtn.click();
    await page.getByText("上下划切集已关闭", { exact: true }).waitFor();
    await page.getByRole("button", { name: "下一部 ↓", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("section:not([inert]) .desktop-video-meta")?.textContent?.includes("Other fixture"));
  }
  return { click_ms: logs.find(e => e.event === "seek.resumed" && e.data.seek === first.data.seek)?.data.elapsed_ms, drag_requests: drags.length,
    ...(!legacy ? { desktop_swipe_ep_wheel: true, speed_menu_keyboard: { playing_preserved: true, paused_preserved: true, activation: ["Space", "Enter"], navigation: ["ArrowUp", "ArrowDown", "Home", "End"], exit: ["Escape", "Tab"], focus_restored: true } } : {}) };
}
async function lifecyclePlayerCheck(page, legacy) {
  let release, held, holdDeadline;
  const gate = new Promise(done => { release = done; });
  const manifestHeld = new Promise(done => { held = done; });
  await page.route("**/hls?*", async route => {
    const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) }); held(); await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
    await page.waitForFunction(() => window.playerSeekFixture && document.querySelector("video"));
    await Promise.race([manifestHeld, new Promise((_, reject) => { holdDeadline = setTimeout(() => reject(new Error("Manifest interception timed out")), 15000); })]);
    clearTimeout(holdDeadline);
    await page.evaluate(async () => { await window.playerSeekFixture.setLogging(true); window.playerSeekFixture.setActive(false); });
    await page.waitForFunction(() => document.querySelector('input[aria-label="播放进度"]').disabled);
    release();
    await page.waitForFunction(() => window.playerSeekFixture.engineState().levels > 0);
    await page.waitForTimeout(350);
    const state = await page.locator("video").evaluate(v => ({ time: v.currentTime, paused: v.paused, ready: v.readyState }));
    const logs = await getLogs(page);
    assert(state.paused, `BACKGROUND_AUTOPLAY: inactive page resumed after manifest returned (${JSON.stringify(state)})`);
    assert.equal(await page.evaluate(() => window.playerSeekFixture.engineState().loading), false, "Inactive player must not load fragments");
    assert(!logs.some(e => e.event === "play.request" && e.data.active === false), "Autoplay must be gated before calling play()");
    assert(!logs.some(e => e.event === "hlsFragLoading"), "Hidden manifest must not start fragment loading");
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);
    await page.locator(legacy ? ".post-player" : ".player-root").hover();
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await page.evaluate(() => window.playerSeekFixture.setActive(false));
    await page.waitForFunction(() => !window.playerSeekFixture.engineState().loading);
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
    assert(await page.locator("video").evaluate(v => v.paused), "Manual pause must survive page reactivation");
    await page.getByRole("button", { name: "播放", exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector("video").paused);
    await page.locator("video").evaluate(v => v.pause());
    await page.evaluate(() => window.playerSeekFixture.setActive(false));
    await page.waitForFunction(() => !window.playerSeekFixture.engineState().loading);
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => !document.querySelector('input[aria-label="播放进度"]').disabled);
    assert(await page.locator("video").evaluate(v => v.paused), "Native/PiP pause must survive page reactivation");
    return { inactive_paused: state.paused, inactive_fragment_loading: false, manual_pause_preserved: true, native_pause_preserved: true };
  } finally { clearTimeout(holdDeadline); release(); await page.unroute("**/hls?*"); }
}
async function lifecycleCheck(page) {
  const feed = await lifecyclePlayerCheck(page, false);
  const legacy = await lifecyclePlayerCheck(page, true);
  const lateMount = [];
  for (const legacy of [false, true]) {
    // Feed intentionally defers its play API while inactive. Mount each real
    // player with a known source only after the parent has become inactive.
    await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&delayed-mount=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
    await page.locator('[data-player-fixture][data-active="true"]').waitFor();
    await page.evaluate(async () => { await window.playerSeekFixture.setLogging(true); window.playerSeekFixture.setActive(false); });
    await page.locator('[data-player-fixture][data-active="false"]').waitFor();
    assert.equal(await page.locator("video").count(), 0, "Parent must become inactive before the player mounts");
    await page.evaluate(() => window.playerSeekFixture.setMounted(true));
    const logs = await waitLog(page, "hls.manifest");
    assert(await page.locator("video").evaluate(v => v.paused), "Late-mounted inactive player must not autoplay");
    assert.equal(await page.evaluate(() => window.playerSeekFixture.engineState().loading), false, "Late-mounted inactive player must not load fragments");
    assert(!logs.some(e => e.event === "play.request"), "Late-mounted autoplay must be gated before calling play()");
    assert(!logs.some(e => e.event === "hlsFragLoading"), "Late-mounted inactive player must not request fragments");
    await page.evaluate(() => window.playerSeekFixture.setActive(true));
    await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);
    lateMount.push({ player: legacy ? "legacy" : "video_surface", inactive_paused: true, inactive_fragment_loading: false, activated_playback: true });
  }
  return { feed, legacy, late_mount_paused: true, late_mount: lateMount };
}

async function proxyRecoveryCheck(page) {
  const players = [];
  for (const legacy of [false, true]) {
    let broken = true, release, held;
    const gate = new Promise(done => { release = done; });
    const intercepted = new Promise(done => { held = done; });
    await page.route("**/hls?*", async route => {
      if (broken) {
        held(); await gate;
        return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "manifest unavailable" });
      }
      const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) });
      return route.fulfill({ response });
    });
    try {
      await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`);
      await page.waitForFunction(() => window.playerSeekFixture && document.querySelector("video"));
      await intercepted;
      await page.evaluate(() => window.playerSeekFixture.setLogging(true));
      release();
      await page.waitForFunction(() => window.playerSeekFixture.logs.some(e => e.event === "hls.error" && e.data.detail === "manifestLoadError" && e.data.fatal));
      assert.equal(await page.locator("video").evaluate(v => v.currentTime), 0, "Fault must prevent initial playback");
      broken = false;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(() => document.querySelector("video").currentTime > 1 && !document.querySelector("video").paused);

      // A subsequent proxy change must retain the same DOM video, current episode,
      // playback position and the user's paused state.
      await page.locator("video").evaluate(v => { v.pause(); v.currentTime = 20; window.__proxyVideo = v; });
      await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2);
      const before = (await getLogs(page)).filter(e => e.event === "proxy.restored").length;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(before => window.playerSeekFixture.logs.filter(e => e.event === "proxy.restored").length > before, before);
      await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
      const paused = await page.locator("video").evaluate(v => ({ paused: v.paused, time: v.currentTime, sameElement: v === window.__proxyVideo }));
      assert(paused.paused && Math.abs(paused.time - 20) < 0.5 && paused.sameElement, `Pause/position must survive: ${JSON.stringify(paused)}`);

      // Hidden pages reload metadata but must not start playing until reactivated.
      await page.evaluate(() => window.playerSeekFixture.setActive(false));
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(() => window.playerSeekFixture.engineState().levels > 0);
      assert(await page.locator("video").evaluate(v => v.paused), "Hidden retry must stay paused");
      await page.evaluate(() => window.playerSeekFixture.setActive(true));
      await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
      assert(await page.locator("video").evaluate(v => v.paused), "Reactivation must retain manual pause");
      await page.getByRole("button", { name: "播放", exact: true }).first().click();
      await page.waitForFunction(() => !document.querySelector("video").paused && document.querySelector("video").currentTime > 20);
      const playingAt = await page.locator("video").evaluate(v => v.currentTime);
      const playingRetries = (await getLogs(page)).filter(e => e.event === "proxy.restored").length;
      await page.evaluate(() => window.dispatchEvent(new Event("hg:proxy-changed")));
      await page.waitForFunction(before => window.playerSeekFixture.logs.filter(e => e.event === "proxy.restored").length > before, playingRetries);
      await page.waitForFunction(time => !document.querySelector("video").paused && document.querySelector("video").currentTime >= time, playingAt);
      if (!legacy) {
        await page.evaluate(() => window.dispatchEvent(new Event("hg:line-changed")));
        assert.equal(await page.locator(".spinner").count(), 0, "Background line switch must not leave a stuck loading spinner on a healthy playing stream");
        assert(!(await page.locator("video").evaluate(v => v.paused)), "Background line switch must keep healthy stream playing");
      }
      const logs = await getLogs(page);
      const current = logs.filter(e => e.data.video_id).map(e => e.data.video_id);
      assert(current.every(id => id === 991), "Proxy save must retain current video");
      players.push({ player: legacy ? "legacy" : "feed", fatal_manifest_recovered: true, paused_time: paused.time,
        same_video_element: paused.sameElement, hidden_stayed_paused: true, playing_resumed: true });
    } finally { release(); await page.unroute("**/hls?*"); }
  }

  // API resolution can fail before a video element exists. Retrying must not
  // depend on mounting the media engine or navigating away from the current item.
  await page.goto(`${report.ui}/tests/player-seek.html?diagnostics=1&api-failure=1&proxy=${encodeURIComponent(report.media)}`);
  await page.getByText("fixture playback API unavailable", { exact: true }).waitFor();
  assert.equal(await page.locator("video").count(), 0);
  await page.evaluate(() => { window.playerSeekFixture.rejectPlaybackApi = false; window.dispatchEvent(new Event("hg:proxy-changed")); });
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
  return { players, failed_api_resolution_retried: true };
}

async function explicitRecoveryCheck(page) {
  const players = [];
  for (const legacy of [false, true]) {
    let broken = true, manifestRequests = 0;
    await page.route("**/hls?*", async route => {
      manifestRequests += 1;
      if (broken) return route.fulfill({ status: 404, headers: { "Access-Control-Allow-Origin": "*" }, body: "manifest unavailable" });
      const response = await route.fetch({ url: fixtureMediaUrl(route.request().url()) });
      return route.fulfill({ response });
    });
    try {
      const url = `${report.ui}/tests/player-seek.html?diagnostics=1&proxy=${encodeURIComponent(report.media)}${legacy ? "&legacy=1" : ""}`;

      // A failed initial manifest must actually be re-requested automatically.
      await page.goto(url);
      const retry = page.getByRole("button", { name: "重试", exact: true });
      await retry.waitFor();
      assert.equal(manifestRequests, 5, "Initial manifest request plus four bounded reloads");
      await page.waitForTimeout(1200);
      assert.equal(manifestRequests, 5, "Terminal failure must stop automatic requests");
      broken = false;
      await retry.click();
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);
      assert.equal(manifestRequests, 6, "Manual retry reloads the manifest instead of just calling play");

      // A recoverable source must stay dormant if covered before its retry fires.
      broken = true; manifestRequests = 0;
      const failedManifest = page.waitForResponse(response => new URL(response.url()).pathname === "/hls" && response.status() === 404);
      await page.goto(url);
      await failedManifest;
      await page.waitForFunction(() => window.playerSeekFixture?.engineState().loading === false);
      await page.evaluate(() => window.playerSeekFixture.setActive(false));
      const hiddenRequests = manifestRequests;
      await page.waitForTimeout(1200);
      assert.equal(manifestRequests, hiddenRequests, "Covered player does not execute pending manifest recovery");
      broken = false;
      await page.evaluate(() => window.playerSeekFixture.setActive(true));
      await page.waitForFunction(() => document.querySelector("video")?.currentTime > 1);

      // Exhaust fatal media recovery without replacing the element or losing
      // its clock. The actual UI retry must then rebuild the engine.
      await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return video?.buffered.length && video.buffered.end(0) >= 30;
      });
      await page.locator(legacy ? ".post-player" : ".player-root").hover();
      if (legacy) {
        await page.getByRole("button", { name: "播放速度 1 倍", exact: true }).click();
        await page.getByRole("button", { name: "播放速度 1.25 倍", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "倍速", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "1.5x", exact: true }).click();
      }
      await page.locator("video").evaluate(video => {
        video.pause(); video.currentTime = 8;
      });
      await page.waitForFunction(() => !document.querySelector("video").seeking && document.querySelector("video").readyState >= 2);
      await page.evaluate(() => {
        window.__retryVideo = document.querySelector("video");
        window.playerSeekFixture.stopForMediaFailure();
      });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await page.evaluate(() => window.playerSeekFixture.failMedia());
        await page.waitForFunction(attempt => window.playerSeekFixture.mediaRecoveryCalls === attempt, attempt);
      }
      await page.evaluate(() => window.playerSeekFixture.failMedia());
      await retry.waitFor();
      await page.evaluate(() => { window.playerSeekFixture.suppressMediaRecovery = false; });
      await retry.click();
      await page.waitForFunction(() => {
        const video = document.querySelector("video");
        return video && !video.paused && video.currentTime >= 8 && video.playbackRate === 1.5;
      });
      assert.equal(await page.locator("video").evaluate(video => video === window.__retryVideo), true,
        "Retry replaces the HLS engine while retaining the DOM video and position");
      players.push({ player: legacy ? "legacy" : "feed", bounded_manifest_reload: true,
        hidden_retry_suspended: true, bounded_media_recovery: true, manual_retry_restores_position_rate_and_play: true });
    } finally {
      await page.unroute("**/hls?*");
    }
  }
  return { players };
}

try {
  if (scenarios.some(name => name !== "ios-native" && name !== "tv" && name !== "review" && name !== "post-flicker")) {
    let mediaDir = args["media-dir"] && resolve(args["media-dir"]);
    if (!mediaDir) {
      temporaryMedia = await mkdtemp(join(tmpdir(), "hghubx-playback-")); mediaDir = temporaryMedia;
      try { generateHlsFixture(mediaDir, "320x180"); } catch { throw new Error("Cannot generate HLS fixture: install FFmpeg (libx264/AAC), set FFMPEG_PATH, or pass --media-dir DIR"); }
    }
    vite = await createViteServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
    await vite.listen(); report.ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
    media = await serveMedia(mediaDir); report.media = `http://127.0.0.1:${media.address().port}`;
    if (scenarios.includes("portrait-fit") || scenarios.includes("ambient")) {
      temporaryPortraitMedia = await mkdtemp(join(tmpdir(), "hghubx-playback-portrait-"));
      try { generateHlsFixture(temporaryPortraitMedia, "360x640"); } catch { throw new Error("Cannot generate portrait HLS fixture: install FFmpeg (libx264/AAC) or set FFMPEG_PATH"); }
      portraitMedia = await serveMedia(temporaryPortraitMedia); report.portraitMedia = `http://127.0.0.1:${portraitMedia.address().port}`;
    }
    browser = await chromium.launch({ headless: true, executablePath: args["browser-executable"], args: ["--autoplay-policy=no-user-gesture-required"] });
    report.browser_version = browser.version();
  }
  for (const name of scenarios) {
    const dir = join(output, name); await mkdir(dir);
    if (scriptScenarios[name]) {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts", scriptScenarios[name].script)], {
          cwd: root, encoding: "utf8", timeout: scriptScenarios[name].timeout, maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { exit_code: 0, ...scriptScenarios[name].metrics };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    if (name === "ios-native") {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts/test-ios-native-media.mjs")], {
          cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { exit_code: 0, transport: "mock IPC/HLS; real Player/VideoSurface" };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    if (name === "review") {
      const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
      let stdout = "", stderr = "";
      try {
        const child = await promisify(execFile)(process.execPath, [join(root, "scripts/test-round-review.mjs")], {
          cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, ...(args["browser-executable"] ? { BROWSER_EXECUTABLE: args["browser-executable"] } : {}) },
        });
        stdout = child.stdout; stderr = child.stderr;
        result.metrics = { focused_checks: true };
        result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
      } catch (error) {
        stdout = error.stdout || ""; stderr = error.stderr || "";
        result.status = "failed"; result.error = error.message;
        result.exit_code = typeof error.code === "number" ? error.code : null;
        result.signal = error.signal || null;
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        await writeFile(join(dir, "stdout.log"), stdout);
        await writeFile(join(dir, "stderr.log"), stderr);
        result.finished = new Date().toISOString();
        await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
      continue;
    }
    const mobileContext = name === "gesture" || name === "portrait-fit" || name === "episode-toast" || name === "ambient" || name === "balance-volume";
    const context = await browser.newContext({ ...(mobileContext ? {userAgent:"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",hasTouch:true} : {}), viewport: name === "portrait-fit" || name === "episode-toast" || name === "ambient" ? { width: 390, height: 844 } : { width: 1000, height: 900 } });
    await context.exposeBinding("collectPlaybackLogs", (_source, entries) => {
      for (const e of entries) jsonl(join(dir, "playback.jsonl"), { ts: e.data.at, event: `web.${e.event}`, data: e.data, transport: "browser-fixture" });
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await context.newPage(), pageErrors = [], externalRequests = [];
    page.setDefaultTimeout(15000);
    // Nothing in these tests should contact an upstream service.
    await context.route("**/*", route => {
      const raw = route.request().url(), url = new URL(raw), mapped = fixtureMediaUrl(raw);
      if (mapped !== raw) return route.continue({ url: mapped });
      if ([report.ui, report.media, report.portraitMedia].includes(url.origin)) return route.continue();
      externalRequests.push({ protocol: url.protocol, host: url.hostname }); return route.abort("blockedbyclient");
    });
    const ids = new WeakMap(); let requestId = 0;
    page.on("request", req => { ids.set(req, ++requestId); jsonl(join(dir, "network.jsonl"), { request: requestId, event: "request", method: req.method(), path: new URL(req.url()).pathname }); });
    page.on("response", response => jsonl(join(dir, "network.jsonl"), { request: ids.get(response.request()), event: "response", status: response.status() }));
    page.on("requestfailed", req => jsonl(join(dir, "network.jsonl"), { request: ids.get(req), event: "failed", error: req.failure()?.errorText }));
    page.on("console", msg => jsonl(join(dir, "console.jsonl"), { type: msg.type(), text: msg.text() }));
    page.on("pageerror", error => { pageErrors.push(error.message); jsonl(join(dir, "console.jsonl"), { type: "pageerror", text: error.message }); });
    const result = { name, status: "running", started: new Date().toISOString() }; report.cases.push(result);
    let deadline;
    try {
      const action = name === "recovery" ? explicitRecoveryCheck(page) : name === "proxy" ? proxyRecoveryCheck(page) : name === "gesture" ? gestureChecks(page) : name === "portrait-fit" ? portraitFitChecks(page, dir) : name === "episode-toast" ? episodeToastChecks(page, dir) : name === "ambient" ? ambientGlowChecks(page) : name === "balance-volume" ? balanceVolumeChecks(page) : name === "seek" || name === "legacy" ? seekChecks(page, name === "legacy") : lifecycleCheck(page);
      result.metrics = await Promise.race([action, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Scenario exceeded 45 seconds")), 45000); })]);
      assert.deepEqual(pageErrors, [], "Browser script errors");
      assert.deepEqual(externalRequests, [], "Unexpected external network requests");
      result.status = "passed"; console.log(`PASS ${name}: ${JSON.stringify(result.metrics)}`);
    } catch (error) {
      result.status = "failed"; result.error = error.message;
      console.error(`FAIL ${name}: ${error.message}`);
    } finally {
      clearTimeout(deadline);
      await getLogs(page).catch(() => {});
      result.page_errors = pageErrors; result.external_requests = externalRequests;
      await page.screenshot({ path: join(dir, "final.png") }).catch(() => {});
      await context.tracing.stop({ path: join(dir, "trace.zip") }).catch(() => {});
      await context.close();
      result.finished = new Date().toISOString();
      await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
    }
  }
} catch (error) {
  report.setup_error = error.message; console.error(error.message);
} finally {
  await browser?.close();
  for (const socket of requests) socket.destroy();
  if (media) await new Promise(done => media.close(done));
  if (portraitMedia) await new Promise(done => portraitMedia.close(done));
  await vite?.close();
  if (temporaryMedia) await rm(temporaryMedia, { recursive: true, force: true });
  if (temporaryPortraitMedia) await rm(temporaryPortraitMedia, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  report.passed = report.cases.filter(c => c.status === "passed").length;
  report.failed = report.cases.filter(c => c.status !== "passed").length + (report.setup_error ? 1 : 0);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Playback checks: ${report.passed} passed, ${report.failed} failed. Artifacts: ${output}`);
  process.exitCode = report.failed ? 1 : 0;
}

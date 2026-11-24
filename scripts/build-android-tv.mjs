#!/usr/bin/env node
// The optional tauri.tv.conf.json selects the TV frontend, independent TV version
// and Android package. Standard builds do not load this hook.
// Local wrappers (`--android-init` / `--android-build`) temporarily overlay
// tauri.tv.conf.json onto tauri.android.conf.json and remove it afterwards so
// standard Android builds cannot accidentally inherit TV settings.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tvConfigPath = join(root, "src-tauri", "tauri.tv.conf.json");
const androidOverlayPath = join(root, "src-tauri", "tauri.android.conf.json");
const tvVersion = JSON.parse(readFileSync(tvConfigPath, "utf8")).version;
const env = {
  ...process.env,
  VITE_APP_EDITION: "tv",
  ...(tvVersion && !process.env.HGHUBX_APP_VERSION ? { HGHUBX_APP_VERSION: String(tvVersion) } : {}),
};
const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const androidInit = argv.includes("--android-init");
const androidBuild = argv.includes("--android-build");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`[tv] ${command} 被 ${result.signal} 中断`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runPnpm(args) {
  // pnpm invokes the Tauri CLI with npm_execpath pointing at its JavaScript entry.
  // Calling that entry with Node avoids Windows' execFile/spawn pnpm.cmd EINVAL.
  const packageManager = process.env.npm_execpath;
  if (packageManager && existsSync(packageManager) && /\.(?:[cm]?js)$/i.test(packageManager)) {
    run(process.execPath, [packageManager, ...args]);
  } else if (process.platform === "win32") {
    // Fixed arguments only: let cmd.exe resolve the package-manager shim.
    run("pnpm.cmd", args, { shell: true });
  } else {
    run("pnpm", args);
  }
}

function runFrontend(script) {
  runPnpm(["run", script]);
}

function prepareAndroid() {
  for (const script of [
    "sync-android-icons.mjs",
    "patch-android-splash.mjs",
    "patch-android-tv.mjs",
  ]) {
    run(process.execPath, [join(root, "scripts", script)]);
  }
}

function runWithTvOverlay(tauriArgs) {
  const extra = argv.filter((arg) => arg !== "--android-init" && arg !== "--android-build");
  const hadOverlay = existsSync(androidOverlayPath);
  const previousOverlay = hadOverlay ? readFileSync(androidOverlayPath) : null;
  copyFileSync(tvConfigPath, androidOverlayPath);
  try {
    runPnpm(["exec", "tauri", ...tauriArgs, ...extra]);
  } finally {
    if (hadOverlay && previousOverlay !== null) {
      // Restore pre-existing local overlay untouched.
      writeFileSync(androidOverlayPath, previousOverlay);
    } else {
      rmSync(androidOverlayPath, { force: true });
    }
  }
}

if (androidInit) {
  runWithTvOverlay(["android", "init"]);
} else if (androidBuild) {
  runWithTvOverlay(["android", "build"]);
} else if (dev) {
  // The dev server is long-lived. Prepare the already initialized native
  // project before starting it so `tauri android dev` gets the TV policy too.
  prepareAndroid();
  runFrontend("dev");
} else {
  runFrontend("build");
  prepareAndroid();
}

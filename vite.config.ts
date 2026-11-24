import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { legacyCss } from "./scripts/legacy-css";

const host = process.env.TAURI_DEV_HOST;
const { version: standardVersion } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };
const { version: tvVersion } = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.tv.conf.json", import.meta.url), "utf8"),
) as { version?: string };

export default defineConfig(({ mode }) => {
  // Android TV 构建期指定 VITE_APP_EDITION=tv（scripts/build-android-tv.mjs 注入）；
  // 其余情况（含未设置）维持现有标准入口 src/main.tsx，构建行为不变。
  const edition =
    process.env.VITE_APP_EDITION ||
    loadEnv(mode, process.cwd(), "VITE_").VITE_APP_EDITION;
  const appVersion = edition === "tv" ? (tvVersion || standardVersion) : standardVersion;
  return {
    resolve: {
      alias: {
        "@edition-bootstrap": fileURLToPath(
          new URL(
            edition === "tv" ? "./src/tv/bootstrap.tsx" : "./src/main.tsx",
            import.meta.url,
          ),
        ),
      },
    },
    // optimize:false 让 Tailwind 不做本地 lightningcss 优化，兼容性变换统一交给 legacyCss。
    plugins: [react(), tailwindcss({ optimize: false }), legacyCss()],
    clearScreen: false,
    // 标准版版本号读 package.json，TV 版读 src-tauri/tauri.tv.conf.json，避免界面与打包版本漂移
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    worker: {
      // Classic IIFE workers run on Chromium 66-79 WebViews where module workers are absent.
      format: "iife",
    },
    build: {
      // 老 Android WebView（Chromium 66）与 iOS 13/14 的语法目标；#138 三设备实测的组合。
      target: ["chrome66", "safari14.1"],
      cssTarget: ["chrome66", "safari13"],
      cssCodeSplit: false,
      // legacyCss performs the final minification after compatibility transforms.
      cssMinify: false,
      minify: "esbuild",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/hls.js")) return "hls";
            return undefined;
          },
        },
      },
    },
  };
});

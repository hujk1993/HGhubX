# 构建与发布

## 责任与边界

构建子系统负责前端打包、Tauri 桌面/移动构建、CI 门禁、版本字段同步、平台产物命名和 release
workflow。它不负责产品功能；发布是维护者/CI 的动作，agent 不在本地 tag、签名或上传 Release。

平台签名密钥只在 GitHub Actions secrets 中存在：Android keystore、iOS 未签名包说明和 macOS
ad-hoc 签名都不应进入仓库或本机脚本输出。

## 事实来源

- 前端脚本与版本：[`package.json`](../../package.json)、[`vite.config.ts`](../../vite.config.ts)、
  [`tsconfig.json`](../../tsconfig.json)、[`tsconfig.node.json`](../../tsconfig.node.json)、
  [`tsconfig.tests.json`](../../tsconfig.tests.json)。
- Tauri 配置：[`src-tauri/tauri.conf.json`](../../src-tauri/tauri.conf.json) 的
  `beforeBuildCommand`、`bundle`、`bundle.android.versionCode`；
  [`tauri.macos.conf.json`](../../src-tauri/tauri.macos.conf.json)、
  [`tauri.linux.conf.json`](../../src-tauri/tauri.linux.conf.json)、
  [`tauri.ios.conf.json`](../../src-tauri/tauri.ios.conf.json)、
  [`tauri.tv.conf.json`](../../src-tauri/tauri.tv.conf.json)。
- Rust 版本：[`src-tauri/Cargo.toml`](../../src-tauri/Cargo.toml) 的 `[package].version`、
  `custom-protocol` feature；[`src-tauri/Cargo.lock`](../../src-tauri/Cargo.lock) 的 `hghubx` 包。
- CI 与 CD 拆分工作流（+ 公共 Composite Actions 与测试预览合成）：
  - 公共环境动作：`.github/actions/setup-node-pnpm`、`.github/actions/install-webkitgtk`、`.github/actions/setup-ffmpeg-chrome`、`.github/actions/setup-android-sdk`、`.github/actions/setup-ios-project`，供以下 5 个工作流统一复用。
  - 标准版 CI：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)（名称 `CI`），负责标准版日常校验（`changes`、`frontend`、`rust`、`smoke`、`playback` 矩阵）；纯文档变更（`docs/**`、`*.md`）仅运行 `frontend`（含文档链接与预算检查），跳过 `rust`/`smoke`/`playback`。
  - 标准版 CD：[`.github/workflows/release.yml`](../../.github/workflows/release.yml)（名称 `Release`），先执行 `preflight`（版本号格式、`check-i18n`、`check-doc-links` 与发布说明提示），再并行执行 5 平台构建（`windows`、`android`、`macos`、`ios`、`linux`）与 `release`。
  - TV 版 CI：[`.github/workflows/tv.yml`](../../.github/workflows/tv.yml)（名称 `TV CI`），负责 TV 版按路径过滤的构建与遥控器验收（`acceptance`）。
  - TV 版 CD：[`.github/workflows/tv-release.yml`](../../.github/workflows/tv-release.yml)（名称 `TV Release`），先执行 `preflight` 校验 TV 版本号/字典/文档，再执行 `package` 与 `release`（`--latest=false` 不抢占仓库 `Latest` 徽章）。
  - 测试预览：[`.github/workflows/sync-test-branch.yml`](../../.github/workflows/sync-test-branch.yml)（名称 `Sync Test Branch`）、[`.github/workflows/test-preview.yml`](../../.github/workflows/test-preview.yml)（名称 `Test Preview`）与 [`scripts/sync-test-branch.mjs`](../../scripts/sync-test-branch.mjs)。`Sync Test Branch` 在 PR/推送 `main` 时仅执行约 15 秒的标签门禁与 `test` 分支合流（`cancel-in-progress: false`，绝不互杀污染 PR 状态；Draft 草稿不提前贴标，纯文档/工作流 PR 自动跳过，拦截外部 PR 修改 `.github/`）；`Test Preview` 通过 `workflow_run` 异步承接 6 平台隔离编译（无密钥）与独立干净运行器 APK 签名，支持手动按单平台重编并原地零 404 空窗滚动更新 `test-pre` Pre-release（`--latest=false`）。`Test Preview` 将 `concurrency` 下沉至各平台构建 job（`cancel-in-progress: true`）与发布 job（`cancel-in-progress: false`），`should_build=false` 的空跑不会取消进行中的构建；`sync-test-branch.mjs` 还会比对 `refs/tags/test-pre` 的树及活跃的 `Test Preview` 运行，在不打断运行中构建的前提下自动补建未发布的 `test` 提交。
- 版本/预算门禁：[`scripts/set-version.mjs`](../../scripts/set-version.mjs)（支持 `--target standard|tv`）、
  [`scripts/check-version-sync.mjs`](../../scripts/check-version-sync.mjs)（支持 `--target all|standard|tv`）、
  [`scripts/check-doc-links.mjs`](../../scripts/check-doc-links.mjs)、
  [`scripts/check-size-budgets.mjs`](../../scripts/check-size-budgets.mjs)、
  [`tools/size-budgets.json`](../../tools/size-budgets.json)。
- iOS/TV 打包：[`scripts/build-ios-unsigned.sh`](../../scripts/build-ios-unsigned.sh)、
  [`scripts/build-android-tv.mjs`](../../scripts/build-android-tv.mjs)（含 `--android-init` / `--android-build` 临时覆盖与自动清理）、
  [`scripts/patch-android-tv.mjs`](../../scripts/patch-android-tv.mjs)；图标/启动屏：
  `generate-ios-icons.mjs`、`sync-ios-icons.mjs`、`patch-ios-splash.mjs`、
  `sync-android-icons.mjs`（同步 `src-tauri/icons/android/` 含 Android 13+ Material You 单色自适应图层 `drawable/ic_launcher_monochrome.xml` 与 `mipmap-anydpi-v26/ic_launcher*.xml`）、`patch-android-splash.mjs`。
- 本地入口：[`Makefile`](../../Makefile) 的 `check`、`test-rust`、`test-web`、`test-tv`、`test-smoke`、
  `docs`、`budget`、`release-check`。

## 主运行时路径

1. 安装依赖用 `pnpm install --frozen-lockfile`（CI 全部如此）。`pnpm build` 执行
   `tsc --noEmit`、`tsc --project tsconfig.node.json`、`tsc --project tsconfig.tests.json`、`vite build`；`vite.config.ts` 标准版从
   `package.json`、TV 版（`VITE_APP_EDITION=tv`）从 `src-tauri/tauri.tv.conf.json` 注入 `__APP_VERSION__`，避免界面版本写死；Rust 诊断日志（`playback_log.rs`、`net_diag.rs`）支持在 TV 编译期通过 `HGHUBX_APP_VERSION` 覆盖 `CARGO_PKG_VERSION`，避免前后端日志版本分裂。
   Vite 构建目标是 `["chrome66","safari14.1"]`（CSS 目标 `chrome66/safari13`，Worker 格式
   `iife` 以兼容无 module worker 的 Chromium 66–79），`cssCodeSplit:false`、`cssMinify:false`；
   `scripts/legacy-css.ts`（enforce:post）在 generateBundle 阶段对汇总后的 CSS 做旧引擎回退
   （dvh、color-mix、cascade layers）、追加 `src/styles/legacy-webview.css` 并用 lightningcss
   压缩。Tailwind 插件以 `optimize:false` 运行，避免其内置优化先吃掉需要降级的语法。TV 构建脚本
   `build-android-tv.mjs` 复用同一 `pnpm build`，自动获得同一条兼容链，且本地 `pnpm android:tv:init` /
   `pnpm android:tv:build` 会在执行前后自动覆盖并清理 `.gitignore` 中的临时 `src-tauri/tauri.android.conf.json`。
2. Tauri 构建的 `beforeBuildCommand` 在 Vite 构建后跑图标生成/同步和 Android 启动屏补丁
   （iOS 启动屏补丁由 `scripts/build-ios-unsigned.sh` 执行），再打包 `dist`。桌面入口为
   `pnpm tauri build`；开发为 `pnpm tauri dev`。
3. `make check` 等价于 `test-rust` + `test-web` + `docs` + `budget` + `release-check`：
   `cargo check --manifest-path src-tauri/Cargo.toml --all-targets`、
   `cargo test --manifest-path src-tauri/Cargo.toml --lib`、`pnpm build`、
   `node scripts/check-doc-links.mjs`、`node scripts/check-size-budgets.mjs`、
   `node scripts/check-version-sync.mjs`。它**不包含**
   `pnpm test:smoke`；smoke 由 CI 的独立 job 和 `make test-smoke` 执行。
4. 标准版 CI 日常校验（`ci.yml`，`pull_request`、推送 `main` 或手动 `mode=ci`）：
   - `frontend`：Node 22、pnpm 10、版本字段检查（同时校验标准版与 TV 版）、文档链接、标准版 `pnpm build`、尺寸预算。
   - `rust`：Linux 系统依赖、`cargo check --all-targets`、`cargo test --lib`。
   - `smoke`：安装 Chromium，运行 `pnpm test:smoke`。
   - `playback`：优先使用运行器的 FFmpeg 和浏览器；需要安装 FFmpeg 时沿用维护者指定的
     `https://mirrors.edge.kernel.org/ubuntu/`，失败不自动换源。单次工作流并行执行 `core` 与 `extended`
     （覆盖 `seek,legacy,lifecycle,gesture,proxy,portrait-fit,ios-native,recovery,review,post-flicker`）；
     `review` 场景运行 `scripts/test-round-review.mjs`（搜索返回键与网络设置检查）；账号同步/批量取消收藏
     回归 `scripts/test-account-sync-empty-state.mjs` 在 smoke 的 `account-sync` 套件中运行，不在 `review` 中重复执行。
     手动 `mode=playback` 可只跑播放诊断或指定 `scenarios` 子集（如 `pnpm test:playback --scenarios review`）。
5. 标准版 CD 打包与发布（`release.yml`，推送 `v*` tag 或手动触发）：在分支上手动运行且 `tag` 留空时，
   只构建所选范围（如 `platforms=ios` 仅验证未签名 ipa），不发布 GitHub Release。各平台构建 job 先跑
   `node scripts/set-version.mjs "$V"`：同步 `package.json`、`tauri.conf.json`（含
   `bundle.android.versionCode`）、`Cargo.toml` 和 `Cargo.lock` 的 `hghubx` 版本。
   `versionCode = major*1_000_000 + minor*1_000 + patch`，minor/patch 超过 999 会报错。
6. 平台产物：
   - Windows：NSIS 安装包 + `HGhubX_<version>_x64_portable.zip`。
   - Android 标准版：`android` job 执行 `pnpm tauri android build --apk --split-per-abi`
     （正式发布编 `aarch64 armv7 x86_64`，`quick` 编 `aarch64 armv7`，显式 `android-arm64` 仅编 `aarch64`），
     按 ABI 产出并用 secrets 中的 keystore `apksigner` 签名，文件名为 `HGhubX_<version>_<abi>.apk`；
     随后 `aapt2 dump badging` 打印实际 `versionCode`。
   - macOS：`quick` 只编 arm64；正式发布编 universal，产物 `HGhubX_<version>_universal.dmg`
     （quick 为 `_arm64.dmg`），ad-hoc 签名。
   - iOS：`pnpm tauri ios init --ci`，用 PlistBuddy 补横竖屏和 ATS，再跑
     `scripts/build-ios-unsigned.sh <version>`；Xcode `CODE_SIGNING_ALLOWED=NO`，产出
     `HGhubX_<version>_ios.ipa`。
   - Linux：`pnpm tauri build` 产出 deb，文件名 `HGhubX_<version>_amd64.deb`。
7. 标准版 `release` job（`release.yml`）依赖五个标准版平台构建 job（不含 TV），在 `!cancelled()` 且
   `windows`、`android`、`macos`、`linux` 全部成功（`ios` 允许成功或失败）时执行；发布条件是 `v*` tag ref，
   或手动触发且 `tag` 非空、`platforms=all`、`quick=false`。它下载已有 artifact，用
   `softprops/action-gh-release` 上传 `artifacts/*`；如果存在 `docs/release-notes/<tag>.md` 就作为正文，
   否则开启 `generate_release_notes` 自动生成说明。
   正文格式以 `docs/release-notes/TEMPLATE.md` 与 AGENTS.md「Release 描述格式」为准：维护者发布前
   按模板写 `docs/release-notes/<tag>.md`；自动生成说明只是缺文件时的兜底。
8. TV 子项目独立 CI / CD 工作流（`tv.yml` + `tv-release.yml`）：
   - `tv.yml`（`TV CI`）：在 `pull_request` / 推送 `main` 且 TV 专属或共享依赖路径变化时（或手动触发）执行
     `node scripts/check-version-sync.mjs --target tv`、`VITE_APP_EDITION=tv pnpm build` 与
     `node scripts/test-tv-remote.mjs`。
   - `tv-release.yml`（`TV Release`）的 `package`：在推送 `tv-v*` tag 或手动触发时执行 `node scripts/set-version.mjs --target tv "$V"`
     并注入 `HGHUBX_APP_VERSION="$V"`，复制 `src-tauri/tauri.tv.conf.json` 到 `src-tauri/tauri.android.conf.json`、
     执行 `pnpm tauri android init --ci` 与按 ABI 分包编译，继续使用 `ANDROID_KEY_*` 签名（保障存量 `com.hghubx.tv`
     覆盖升级连续性），产出 `HGhubX-TV_<version>_<abi>.apk` 并由 `aapt2` 复核。
   - `tv-release.yml` 的 `release`：在 `tv-v*` tag（或手动触发且 `tag` 非空、`quick=false`）且 `package` 成功时，
     读取 `docs/release-notes/tv/<tag>.md`（模板见 [`docs/release-notes/tv/TEMPLATE.md`](../release-notes/tv/TEMPLATE.md)），
     以 `--latest=false` 发布独立 TV GitHub Release（不抢占仓库 `Latest` 徽章；仅当去掉 `tv-v` 前缀后含 `-` 或显式勾选
     `prerelease` 时标为 Pre-release）。TV 客户端通过 `check_update(edition="tv")` 读取该 Release 资产摘要与大小，
     校验 SHA-256 后由系统安装器覆盖升级。

## 状态转换

- 版本：源版本（tag 或 `tauri.conf.json`）→ `set-version.mjs` 校验 `major.minor.patch` →
  写四份文件 → 平台构建。`check-version-sync.mjs` 由 `ci.yml` 的 `frontend` job 调用；
  它要求四处版本字符串一致，并检查 Android `versionCode` 与公式推导值一致。
- Android versionCode：版本号解析 → `major*1e6 + minor*1e3 + patch` → 写入
  `bundle.android.versionCode` → APK 签名 → `aapt2` 复核。
- iOS：`ios init` 生成工程 → 补 plist → 启动 Tauri options server → Xcode release 构建 →
  `CODE_SIGNING_ALLOWED=NO` → 打包 Payload → `unzip -tq` 校验 → artifact。
- CI：PR 或推送 `main` 触发 `frontend`/`rust`/`smoke`/`playback`，不打包。
  `v*` tag 触发全平台构建；手动打包用 `mode=package` 和 `platforms` 选范围，
  `tag` 留空只上传 Actions 产物，不进入发布任务。
- 发布：满足上述 tag 条件 → 等待平台 job 结束 → release job 下载已有 artifact 并合并 →
  读取版本说明 → 创建/更新 GitHub Release。在分支上手动运行且 `tag` 留空不进入发布 job。

## 约束与失败行为

- 安装播放测试依赖时，只修改临时 CI 运行器的软件源，不影响客户端的线路或本机配置。
  [CI 44402407330](https://github.com/zxsos/HGhubX/actions/runs/44402407330/job/135148647519)
  的扩展用例曾在安装 FFmpeg 前遇到镜像握手失败和连接超时，最终报
  `E: Unable to locate package ffmpeg`（退出 `100`），未执行播放用例。为绕开该故障曾临时添加
  Ubuntu 官方归档源回退；维护者确认保留原镜像后已撤销。之后遇到相同失败，按环境故障记录，
  保持原镜像重跑；替换镜像或添加换源回退前须获明确同意。

- 版本字段必须同步：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、
  `src-tauri/Cargo.lock` 的 `hghubx`。只改一处会造成“关于页/更新检查/安装包”版本错位。
- `custom-protocol` feature 不能删；Tauri 打 iOS/桌面包会传这个 feature，缺失会导致
  `tauri ios build` 直接报错。
- 尺寸预算按关注点只降不升：`check-size-budgets.mjs` 计非空非注释代码行；`--update` 默认拒绝
  提高预算，必须先搬走关注点。纯文件→目录移动若新增模块/`use` 头，必须在配置中保留
  `previous` 和原因，行为代码不能增加。删注释不能过关。
- Android release 缺 `ANDROID_KEY_BASE64` 必须失败，不能产出未签名包冒充 release；签名后
  必须复核 APK 里的 versionCode。
- iOS 是 unsigned ipa，不能宣称可直接安装/上架；真机安装需要用户自己的签名流程。
- CI 失败不能靠删测试/放宽断言修绿；平台专属测试应 `cfg` 或拆 job，联网测试保持 `#[ignore]`
  并显式运行。
- agent 不执行 `git tag`、不创建 GitHub Release、不上传 secrets/产物；发布由维护者或受保护的
  workflow 完成。

## 验证命令

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:smoke
cargo test --manifest-path src-tauri/Cargo.toml --lib
make check
make test-tv
node scripts/check-doc-links.mjs
node scripts/check-version-sync.mjs
node scripts/check-version-sync.mjs --target tv
```

`make check` 不包含 smoke；需要浏览器用例时单独 `pnpm test:smoke`（含 `account-sync`；账号 fixture
也可单独用 `node scripts/test-account-sync-empty-state.mjs` 运行）。`pnpm test:playback` 需要
FFmpeg/Chromium，iOS 打包校验通过 `ci.yml`（`mode=package, platforms=ios`）在 macOS runner 执行。
报告里必须写清命令、版本/输入、字面结果和退出状态；没有运行的命令不能写成“已通过”。

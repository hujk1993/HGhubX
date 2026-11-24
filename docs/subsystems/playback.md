# 播放

## 责任与边界

播放子系统负责把 `api_play`/帖子播放接口返回的媒体地址变成一个可播放的
`<video>`：选择 hls.js 或原生播放、管理播放/暂停意图、HLS 恢复、seek、播放时钟、
全屏/画中画、观看进度和本地媒体传输。它同时服务首页/列表里的 Feed 播放器和吃瓜详情的
内嵌 `Player`。

不在这里负责：详情和标签门的请求策略（见 [feed-and-detail.md](feed-and-detail.md)）、
上游线路选择与凭据（见 [upstream-lines.md](upstream-lines.md)）、网络代理与媒体字节
校验（见 [network-proxy-media.md](network-proxy-media.md)）。播放器只消费已经通过
作用域/标签检查的地址。

## 事实来源

- Feed 调用方：[`src/features/feed/Feed.tsx`](../../src/features/feed/Feed.tsx) 中的
  `requestPlay`、`playKey`、`playGuard`、`isCurrentPlayback`、`onTimeTick`、
  `onDurationTick`、`resumeRef`、`enterFs`/`exitFs`、`keepAlive`。
- Feed 播放内核：[`src/features/playback/VideoSurface.tsx`](../../src/features/playback/VideoSurface.tsx)
  的 `VideoSurface`、`VideoHandle.seek`、`reportSize`、`handleVideoError`。
- 内嵌播放器：[`src/features/playback/Player.tsx`](../../src/features/playback/Player.tsx)
  的 `Player`，以及 `PlayerControls.tsx`、`PlaybackLock.tsx`、`PlaybackProgress.tsx`。
- 恢复与时钟：[`hlsRecovery.ts`](../../src/features/playback/hlsRecovery.ts) 的
  `createHlsRecovery`；[`playbackClock.ts`](../../src/features/playback/playbackClock.ts)
  的 `createPlaybackClock`；[`usePlaybackActivity.ts`](../../src/features/playback/usePlaybackActivity.ts)、
  [`useProxyPlaybackRecovery.ts`](../../src/features/playback/useProxyPlaybackRecovery.ts)。
- 输入与传输：[`useSeekInput.ts`](../../src/features/playback/useSeekInput.ts)、
  [`useInlinePlayerFullscreen.tsx`](../../src/features/playback/useInlinePlayerFullscreen.tsx)、
  [`src/shared/lib/fullscreen.ts`](../../src/shared/lib/fullscreen.ts)、
  [`mediaTransport.ts`](../../src/features/playback/mediaTransport.ts)、
  [`mediaErrors.ts`](../../src/features/playback/mediaErrors.ts)、
  [`AmbientGlow.tsx`](../../src/features/playback/AmbientGlow.tsx)、
  [`balanceVolume.ts`](../../src/features/playback/balanceVolume.ts)。
- 后端传输：[`src-tauri/src/ios_media_http.rs`](../../src-tauri/src/ios_media_http.rs)、
  [`src-tauri/src/linux_http.rs`](../../src-tauri/src/linux_http.rs)、
  [`src-tauri/src/media/mod.rs`](../../src-tauri/src/media/mod.rs)、
  [`src-tauri/src/media/response.rs`](../../src-tauri/src/media/response.rs)、
  [`src-tauri/src/media/hls.rs`](../../src-tauri/src/media/hls.rs)、
  [`src-tauri/src/media/segment.rs`](../../src-tauri/src/media/segment.rs)。

## 主运行时路径

1. Feed 通过 `api.play(id, ep)` 取得 `streams.main`、旧字段 `video_url`，或仅存在 HEVC 时的
   `streams.hevc`/`video_url_hevc` 回退；`preferHevc` 且存在 `streams.hevc` 时优先 HEVC。播放器拿到的是上游 m3u8，
   通过 `playbackSource` 转成 `${LOCAL}/hls?u=...`；已经是 `/hls`、`/seg` 的本地地址
   不会被重复包裹。
2. `VideoSurface` 在 `Hls.isSupported()` 且不是直通 `/seg` 时创建 hls.js；
   否则进入原生 `<video>`。iOS 原生传输调用 `media_http_origin`，把能力前缀拼到
   `127.0.0.1` 的 `/hls`/`/seg` 路由；Linux 的 `LOCAL` 固定为
   `http://127.0.0.1:17650`，由 GStreamer 直接取 HLS。
3. hls.js 使用 `autoStartLoad: false`，在 `MANIFEST_PARSED` 后按
   `startPosition`/`resume` 调 `startLoad`。`FRAG_BUFFERED` 清空恢复计数和错误；
   `ERROR` 只把 fatal network/media 交给 `createHlsRecovery`。
4. `usePlaybackActivity` 在页面失活时暂停并 `stopLoad()`（处于画中画 `pictureInPictureElement`
   时保持播放，退出画中画且页面仍失活时再暂停），在重新激活时按 `wanted` 与 `startPosition`
   恢复；`play()` 的 Promise 返回后会再次检查页面是否仍激活。被页面栈覆盖的底层播放页（经
   [`src/shared/model/pageVisibility.ts`](../../src/shared/model/pageVisibility.ts) 的 `PageCoveredContext` 感知，
   且未处于画中画时），`VideoSurface` 通过 `useProxyPlaybackRecovery.stash()` 暂存当前进度、倍速与播放/暂停意图后
   销毁 `hls.js` 并清空 `<video>` 源以释放硬件解码器，返回顶层时按暂存状态自动续播或保持暂停；非活跃态同时卸载
   `AmbientGlow` 与移动端 `blur-3xl` 氛围模糊层（微光开启或 Android 端不再渲染被遮盖的 `blur-3xl`）。在 Android WebView（`.plat-android`）上，播放页覆盖控件关闭压在硬件 `<video>` 上的 `backdrop-filter` 改用半透明深色底，未缩放时不套 `translate3d`，仅活跃 `<section>` 渲染 `FeedItemChrome` 且仅缩放态挂载还原胶囊，`AmbientGlow` 改用 `8×5` 画布按 250ms 采样并依靠 GPU 双线性放大替代全屏 `filter: blur(44px)`，避免 Skia/Viz 合成瓦片闪烁与错层（#240）。
5. seek 有两种入口：桌面 `useSeekInput`/`PlayerControls`，移动端
   `useSeekInput`/进度条手势。指针移动只预览，松手提交一次；
   `VideoSurface.seek` 把目标夹到 `duration - 0.15`（避免 iOS 片尾卡死），
   通知 hls `startLoad(target)`，写入 `currentTime`，原本在播放才续播。
6. 播放时钟是外部 store：`onTime` 只 `publish` 时钟，进度组件
   `PlaybackProgress`/`PlaybackTime` 用 `useSyncExternalStore` 重绘，避免整个 Feed
   每 250ms 重渲染。Feed 每 5 秒把观看进度通过 `addHistory` 落盘，卸载时再补一次。
7. `hg:proxy-changed` 会触发 `useProxyPlaybackRecovery.retry`：保存
   `src/time/playing/rate`，增加 revision，在同一 `video` 元素上重建 HLS/原生媒体连接；
   收到 metadata/data 后恢复位置、倍速与播放意图，期间用户显式暂停则保持暂停。

## 状态转换

- `src` 变化：清理旧 HLS/原生连接 → 清空尺寸和错误 → `waiting` →
  manifest/metadata → `playing`、`paused` 或 `error`。
- HLS 故障：fatal network/media → `pending` → 250ms × (attempt+1) 后尝试 →
  成功缓冲回到正常；第 4 次后交给 `onFatal`。非 network/media fatal 立即结束。
- 页面失活：`active=false` → 暂停 + `stopLoad()`；被标签门/教程覆盖也走同一条
  active 边界，不启动后台恢复。
- 页面恢复：只有 `wanted=true` 才恢复；原生控件造成的暂停也要被记住，不能凭
  “之前自动播放过”强行继续。
- seek：preview → commit → `seeking` → `seeked`/`playing`；拖动取消、
  页面失活或换源不会提交旧目标。移动端画面横拖（`scrub`）与底栏直拖（`barPct`）统一在底部进度条上
  加粗高亮预览并展示「目标时间 / 总时长」胶囊，不在屏幕中央叠加进度条；全屏闲置隐藏期间横拖画面会
  在底部自动唤起进度条。
- 移动端首页普通视频播放的底部「选集」「静音」「上下划切集」「全屏」使用低不透明度底色与轻微背景模糊，
  以减少对画面的遮盖；文字和图标保持原有颜色与可点击范围。此样式不应用到清屏、全屏控制条或其他页面。
- 控件闲置隐藏（`src/features/feed/fsIdle.ts`）：桌面 2.8s（键盘聚焦控件时不隐藏）；
  移动沉浸全屏按设置 `fsIdleSecs`（`hghubx_app_v1` 内，0/3/5/10 秒，默认 3，0=不自动隐藏），
  单击画面切换显隐、双击仍是暂停/播放；暂停时屏幕中心显示播放图标，同时在同一 `playback-hint` toast 槽展示「第 X 集 / Y」，卡片随暂停图标同步显示，恢复播放、退出全屏、拖动预览、屏幕锁定或播放出错时同步收起；该卡片使用无 TTL 的 sticky 提示，不会在 2.2 秒后自行消失。桌面与内嵌全屏统一经
  `src/shared/lib/fullscreen.ts` 兼容标准与 `webkit` 前缀 Fullscreen API，不支持或被拒绝时
  回退至应用内全屏并同步 Tauri 窗口全屏。桌面闲置隐藏（`.player-root.is-idle`）同时淡出
  控制条、社交栏、左下信息、上下切换按钮与上下文页左上角标题栏（`.desktop-context-header`），
  并把媒体容器内的鼠标指针设为 `cursor: none`，移动鼠标由 `wake()` 恢复；锁定
  （`.player-root.is-locked`）同样隐藏左上角标题栏的按钮与文字。桌面原生/回退全屏由
  `useFeedViewport` 的 `fullscreen` 跟踪（不经过 `store.fs`）：进入全屏前先按当前条目重锚
  `scrollTop` 并清掉待定滚动切换，全屏期间 `onScroll` 与重锚 effect 都跳过，避免容器高度
  变化后按旧像素偏移切到别的剧（issue #180）。移动端 Feed 底部信息容器保持 `pointer-events: none`
  （仅对详情按钮与进度条显式开启命中），避免跨宽布局盒遮挡右侧操作栏（如「全屏」）与画面手势。CSS 旋转舞台（`.fs-landscape`）上
  的分区判定/横拖定位/上下划切集/长按换挡都先经 `getHoldPoint` 把屏幕坐标换算回
  播放器坐标（rotate(90deg)：播放器 x=屏幕 dy、y=屏幕 -dx）。长按加速/减速只临时改变倍速，
  松手恢复原速度；不提供拖动到顶部胶囊的持久锁定，持久倍速统一通过全屏倍速按钮或
  「更多」里的倍速选项设置。全屏 overlay 的 touch-action
  固定为 none，避免原生 pan-y 把视觉横滑取消掉。
- 媒体错误：hls fatal 显示 `type/details/status`，原生错误走
  `mediaErrorMessage`；手动重试走同一个 `useProxyPlaybackRecovery` 路径。
- 移动端「平衡音量」（`balanceVolume.ts`，`hghubx_app_v1.balanceVolume`，默认 `false`）：仅在支持 MSE + Web Audio 的移动端环境展示入口并启用；首次显式手势解锁 `AudioContext` 后挂接输入侧原始 RMS 分析、扣除 `video.volume` 偏移的慢速 AGC 与峰值限幅器；跨源无 CORS / 原生非 `blob:` 源不挂接 `MediaElementAudioSourceNode`（标记 `unsupported`），页面失活或暂停时停止采样定时器并在无在播元素时挂起 `AudioContext`。

## 约束与失败行为

- HLS 每个连续故障期最多 4 次恢复。`MANIFEST_LOAD_ERROR` 与
  `MANIFEST_LOAD_TIMEOUT` 必须用 `loadSource(url)`，不能只 `startLoad`；
  其他网络错误用 `startLoad(currentTime)`；媒体错误先 `recoverMediaError()`，
  再 `startLoad(time)` 并恢复播放意图。
- 被覆盖的播放页保留 pending 错误，但不发请求；取消/销毁后计时器和 pending
  必须清空。没有这个边界，首页会同时为多张卡片恢复清单。
- hls.js 配置禁用 interstitials/content steering，`preferManagedMediaSource:false`；
  iOS 关闭 worker。媒体层还会移除 playlist 中可派生请求的 URI 字段。
- iOS AVFoundation 不能读 `hg://`，所以只通过 `ios_media_http` 的临时 loopback
  capability 提供 `/hls` 与 `/seg`；不支持 `/img`，也不把该端口暴露成通用代理。
- Linux WebKitGTK 没有 MediaSource 时由 GStreamer 播 HLS；`linux_http` 绑定失败时
  播放会失败而不是静默切到自定义协议。端口必须和 `src/shared/api/api.ts` 的 `LOCAL` 常量一致。
- 原生错误不会无限重试：`mediaErrorMessage` 只给用户可理解的
  network/decode/unsupported 提示；手动重试通过 proxy retry 重建媒体连接。

## 验证命令

```sh
pnpm build
pnpm test:playback --scenarios seek,legacy,lifecycle,gesture,proxy,portrait-fit,ios-native,recovery,review,tv
node scripts/test-ios-native-media.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`pnpm test:playback` 使用本地 HLS fixture，需要 FFmpeg 和 Chromium；它不能替代
iOS WKWebView、Android WebView、Linux GStreamer 的实机矩阵。`test:ios-native-media`
检查前端传输契约，不证明真机 AVFoundation 已通过。上述命令是验证入口，不代表本轮已经运行。
`tv` 场景入口是 `scripts/test-tv-remote.mjs`（mock Tauri IPC、真实 TV bootstrap）。视口 resize 后
必须等焦点提交并断言 `activeElement` 命中目标控件（未命中重试一次），再读焦点派生样式；
不得在与 resize 同一次 evaluate 里同步断言 `:focus` 样式。

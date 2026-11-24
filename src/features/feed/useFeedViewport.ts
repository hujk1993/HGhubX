import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { registerOverlayBack } from "../../shared/lib/back";
import {
  exitDocumentFullscreen, getFullscreenElement, onFullscreenChange,
  requestElementFullscreen, setTauriWindowFullscreen,
} from "../../shared/lib/fullscreen";
import { useFsOrientation } from "../playback/useFsOrientation";
import type { VideoHandle } from "../playback";
import type { Toast } from "../../shared/model/store";
import { resolveFullscreenEpisodeSwipe } from "./fullscreenEpisodeSwipe";
import { tr } from "../../shared/i18n";

export type PinchState = { d0: number; mx0: number; my0: number; s0: number; x0: number; y0: number };
export type FeedPanel = "episodes" | "comments" | "article" | "detail" | "more" | null;

type Args = {
  playerRootRef: RefObject<HTMLDivElement | null>;
  boxRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<VideoHandle | null>;
  pinchRef: RefObject<PinchState | null>;
  videoIds: number[];
  effectiveVideoIds: number[];
  startIndex: number;
  mode: "home" | "context";
  kind: "video" | "post";
  active: boolean;
  isItemAllowed: (id: number | undefined) => boolean;
  isDesktop: boolean;
  fs: boolean;
  setFs: (v: boolean) => void;
  setClean: (v: boolean) => void;
  paused: boolean;
  wake: () => void;
  swipeEp: boolean;
  curIdHint?: number;
  epMap: Record<number, number>;
  setEpMap: Dispatch<SetStateAction<Record<number, number>>>;
  episodesByVideo: Record<number, number>;
  setPanel: Dispatch<SetStateAction<FeedPanel>>;
  onNearEnd?: () => void;
  toast?: (msg: string, icon?: Toast["icon"], tag?: string) => void;
};

export function useFeedViewport({
  playerRootRef, boxRef, videoRef, pinchRef, videoIds, effectiveVideoIds, startIndex, mode, kind, active, isItemAllowed,
  isDesktop, fs, setFs, setClean, paused, wake, swipeEp, epMap, setEpMap, episodesByVideo, setPanel, onNearEnd, toast,
}: Args) {
  const [position, setPosition] = useState(() => ({ id: videoIds[startIndex], index: startIndex }));
  const index = useMemo(() => {
    if (!effectiveVideoIds.length) return -1;
    const anchored = effectiveVideoIds.indexOf(position.id);
    if (anchored >= 0) return anchored;
    // Only find a replacement after removal, not on every playback/UI update.
    const source = videoIds.indexOf(position.id);
    if (source >= 0) {
      const visible = new Set(effectiveVideoIds);
      for (let i = source + 1; i < videoIds.length; i++) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
      for (let i = source - 1; i >= 0; i--) {
        if (visible.has(videoIds[i])) return effectiveVideoIds.indexOf(videoIds[i]);
      }
    }
    return Math.max(0, Math.min(position.index, effectiveVideoIds.length - 1));
  }, [effectiveVideoIds, videoIds, position.id, position.index]);

  const idsRef = useRef(effectiveVideoIds);
  idsRef.current = effectiveVideoIds;
  const setIndex = useCallback((next: number) => {
    const id = idsRef.current[next];
    if (id !== undefined) setPosition({ id, index: next });
  }, []);

  const [renderIndex, setRenderIndex] = useState(startIndex);
  const [nativeFs, setNativeFs] = useState(() => !!getFullscreenElement());
  const [fallbackFs, setFallbackFs] = useState(false);
  const fallbackFsRef = useRef(false);
  const fsTokenRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mountedRef = useRef(true);
  const fullscreen = nativeFs || (isDesktop && active && fallbackFs);
  /* 系统是否真的转成了横屏（iOS 原生旋转后为 true） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );
  /* 进出全屏过渡期多次续播，防止 iOS 把播放打断 */
  const keepAliveTimers = useRef<number[]>([]);
  /* 竖屏下看横屏视频：contain = 完整显示，cover = 放大铺满 */
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");

  const curId = effectiveVideoIds[index];
  const allowed = isItemAllowed(curId);
  const totalEpisodes = curId !== undefined ? (episodesByVideo[curId] ?? 0) : 0;

  /* ── 上下划切集 ──────────────────────────────────────────
   * 「上下划切集」开启时，播放区 overlay 的 touch-action 是 none，
   * 原生滚动不参与：上/下划手势在抬手时一次性判定——
   * 有上一/下一集就切集；没有就切上一/下一部剧。
   * 关闭时保持原生滚动，停稳 150ms 后按所在屏切剧。
   */
  const idxRef = useRef(index);
  idxRef.current = index;
  const anchoredScroll = useRef<number | null>(null);
  /* 桌面原生/回退全屏由 fullscreen 跟踪，不经过 store.fs；滚动判定与重锚都要认它，
     否则全屏改变容器高度后 onScroll 会按旧像素偏移算出别的条目（#180-3）。 */
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  useLayoutEffect(() => {
    const id = effectiveVideoIds[index];
    if (id !== undefined && (position.id !== id || position.index !== index)) {
      setPosition({ id, index });
      setRenderIndex(index);
    }
    // The scroll container is recreated after the tag gate/one-time prompt.
    // Anchor by content ID before paint, including a nonzero starting position.
    if (boxRef.current) {
      const top = index * (boxRef.current.clientHeight || 1);
      if (Math.abs(boxRef.current.scrollTop - top) > 1) {
        anchoredScroll.current = top;
        boxRef.current.scrollTop = top;
      }
    }
  }, [boxRef, effectiveVideoIds, index, position.id, position.index, allowed, active]);

  const swipeTimer = useRef(0);
  const resolveSwipe = useCallback((target: number) => {
    const prev = idxRef.current;
    if (target === prev) return;
    idxRef.current = target;
    setIndex(target);
  }, [setIndex]);

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    if (fs || fullscreenRef.current || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    if (anchoredScroll.current !== null) {
      const top = anchoredScroll.current;
      anchoredScroll.current = null;
      if (Math.abs(el.scrollTop - top) <= 1) return;
    }
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
    if (renderIndex !== i) setRenderIndex(i);
    if (onNearEnd && mode === "home" && i >= effectiveVideoIds.length - 3) onNearEnd();
    window.clearTimeout(swipeTimer.current);
    swipeTimer.current = window.setTimeout(() => resolveSwipe(i), 150);
  }, [boxRef, pinchRef, effectiveVideoIds.length, onNearEnd, resolveSwipe, fs, fullscreen, mode, renderIndex]);

  const go = useCallback((delta: number) => {
    if (!effectiveVideoIds.length) return;
    const next = Math.max(0, Math.min(effectiveVideoIds.length - 1, index + delta));
    if (fs || fullscreenRef.current) {
      resolveSwipe(next);
      return;
    }
    const el = boxRef.current;
    if (!el) return;
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [boxRef, fs, index, effectiveVideoIds.length, resolveSwipe]);

  /* 统一的上下切换：swipeEp 开启且为多集视频时优先切集，否则切剧。
     桌面端滚轮/触控板、键盘 ↑↓ 与右侧按钮都走这里，和移动端上下划手势保持一致。 */
  const stepDir = useCallback((dir: number) => {
    if ((fs || fullscreenRef.current) && kind === "video" && curId !== undefined && (swipeEp || totalEpisodes > 1)) {
      const ep = epMap[curId] || 1;
      const result = resolveFullscreenEpisodeSwipe(ep, totalEpisodes, dir === 1 ? -1 : 1);
      if (result && "message" in result) {
        toast?.(result.message, "info", "playback-hint");
        return;
      }
      if (result) {
        setEpMap((m) => ({ ...m, [curId]: result.target }));
        setPanel(null);
        toast?.(tr("第 {0}集{1}", result.target, totalEpisodes ? ` / ${totalEpisodes}` : ""), "info", "playback-hint");
        return;
      }
    }
    if (swipeEp && kind === "video" && curId !== undefined) {
      const ep = epMap[curId] || 1;
      const want = dir === 1 ? (totalEpisodes > 1 && ep < totalEpisodes ? ep + 1 : 0) : (ep > 1 ? ep - 1 : 0);
      if (want) {
        setEpMap((m) => ({ ...m, [curId]: want }));
        setPanel(null);
        toast?.(tr("第 {0}集{1}", want, totalEpisodes ? ` / ${totalEpisodes}` : ""), "info", "playback-hint");
        return;
      }
    }
    go(dir);
  }, [fs, swipeEp, kind, epMap, curId, totalEpisodes, setEpMap, setPanel, go, toast]);

  /* 桌面端开启「上下划切集」或处于全屏时，拦截播放区滚轮/触控板纵向滚动并转为 stepDir：
     桌面端 touch-action:none 不影响 wheel 事件，若不拦截会直接驱动 boxRef 原生纵向切剧。 */
  const stepDirRef = useRef(stepDir);
  stepDirRef.current = stepDir;
  const wheelStateRef = useRef({ acc: 0, lastAt: 0, lockedUntil: 0, lockDir: 0 });
  useEffect(() => {
    if (!isDesktop || !active) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const intercept = fullscreen || (swipeEp && kind === "video");
    if (!intercept) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * (el.clientHeight || 600) : e.deltaY;
      const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * (el.clientWidth || 800) : e.deltaX;
      if (Math.abs(dy) <= Math.abs(dx)) return;
      e.preventDefault();
      window.clearTimeout(swipeTimer.current);
      const now = Date.now();
      const s = wheelStateRef.current;
      const dir = dy > 0 ? 1 : -1;
      if (now - s.lastAt > 180 || (s.lockDir !== 0 && dir !== s.lockDir)) {
        s.acc = 0;
        s.lockedUntil = 0;
        s.lockDir = 0;
      }
      s.lastAt = now;
      if (now < s.lockedUntil) return;
      s.acc += dy;
      if (Math.abs(s.acc) < 36) return;
      s.acc = 0;
      s.lockedUntil = now + 260;
      s.lockDir = dir;
      stepDirRef.current(dir);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [boxRef, isDesktop, active, fullscreen, swipeEp, kind]);

  const canStep = useCallback((dir: number) => {
    if (swipeEp && kind === "video" && curId !== undefined) {
      const ep = epMap[curId] || 1;
      if (dir === 1 ? (totalEpisodes > 1 && ep < totalEpisodes) : ep > 1) return true;
    }
    const next = index + dir;
    return next >= 0 && next < effectiveVideoIds.length;
  }, [swipeEp, kind, curId, epMap, totalEpisodes, index, effectiveVideoIds.length]);

  /* 进出全屏：iOS 会在这时把播放打断，过渡期多补几次 play()（用户主动暂停时不恢复） */
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const keepAlive = useCallback(() => {
    for (const t of keepAliveTimers.current) window.clearTimeout(t);
    keepAliveTimers.current = [];
    if (pausedRef.current) return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      keepAliveTimers.current.push(window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (!pausedRef.current && v && v.paused) videoRef.current?.play();
      }, delay) as unknown as number);
    }
  }, [videoRef]);

  const closeFallbackFs = useCallback(() => {
    fsTokenRef.current++;
    if (!fallbackFsRef.current) return;
    fallbackFsRef.current = false;
    setFallbackFs(false);
    if (typeof document !== "undefined") delete document.documentElement.dataset.desktopFs;
    setTauriWindowFullscreen(false);
  }, []);

  useEffect(() => onFullscreenChange(() => {
    const on = !!getFullscreenElement();
    setNativeFs(on);
    if (on && fallbackFsRef.current) closeFallbackFs();
  }), [closeFallbackFs]);

  useLayoutEffect(() => {
    if (!active || !isDesktop) closeFallbackFs();
  }, [active, isDesktop, closeFallbackFs]);

  useLayoutEffect(() => {
    if (!isDesktop || !active || !fallbackFs) return undefined;
    document.documentElement.dataset.desktopFs = "true";
    const removeBack = registerOverlayBack(() => {
      closeFallbackFs();
      keepAlive();
      return true;
    });
    return () => {
      removeBack();
      delete document.documentElement.dataset.desktopFs;
    };
  }, [isDesktop, active, fallbackFs, closeFallbackFs, keepAlive]);

  const toggleFull = useCallback(() => {
    const el = playerRootRef.current ?? boxRef.current?.parentElement;
    if (!el) return;
    if (getFullscreenElement() || fallbackFsRef.current) {
      fsTokenRef.current++;
      closeFallbackFs();
      if (getFullscreenElement()) void exitDocumentFullscreen().catch(() => {});
      keepAlive();
      return;
    }
    /* 进入全屏前固定当前条目并清掉待定的滚动切换，和移动端 enterFs 一致：
       全屏会改变容器高度，残留的 scrollTop/防抖会把画面切到别的剧（#180-3）。 */
    window.clearTimeout(swipeTimer.current);
    const box = boxRef.current;
    if (box) {
      const top = idxRef.current * (box.clientHeight || 1);
      anchoredScroll.current = top;
      box.scrollTop = top;
    }
    wake();
    keepAlive();
    const token = ++fsTokenRef.current;
    void (async () => {
      try {
        await requestElementFullscreen(el);
        if (!mountedRef.current || fsTokenRef.current !== token || !activeRef.current) return;
        if (getFullscreenElement() === el) return;
      } catch {
        /* WebView without Element Fullscreen API falls back to window fullscreen. */
      }
      if (!mountedRef.current || fsTokenRef.current !== token || !activeRef.current || !isDesktop) return;
      fallbackFsRef.current = true;
      setFallbackFs(true);
      setTauriWindowFullscreen(true);
    })();
  }, [playerRootRef, boxRef, closeFallbackFs, keepAlive, wake, isDesktop]);

  const enterFs = useCallback((landscape: boolean) => {
    /* 先把当前可见项锁定下来，再收起滚动容器：
       否则进入全屏后 scrollTop 归零，若此前滚动后的 index 还在 150ms 防抖里，
       会被 resolveSwipe(0) 改回第一屏，出现「全屏后变成另一个视频」。 */
    const el = boxRef.current;
    if (el && !isDesktop) {
      window.clearTimeout(swipeTimer.current);
      const h = el.clientHeight || 1;
      const i = Math.max(0, Math.min(effectiveVideoIds.length - 1, Math.round(el.scrollTop / h)));
      if (i !== idxRef.current) resolveSwipe(i);
    }
    setClean(false);
    setFs(true);
    wake();
    keepAlive();
    if (!isDesktop) {
      try { void invoke("set_orientation", { landscape }); } catch { /* ignore */ }
      if (landscape) {
        try {
          (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
        } catch { /* ignore */ }
      }
    }
  }, [boxRef, isDesktop, keepAlive, resolveSwipe, effectiveVideoIds.length, setClean, setFs, wake]);

  const exitFs = useCallback(() => {
    setClean(false);
    setFs(false);
  }, [setClean, setFs]);

  useFsOrientation(fs, isDesktop, keepAlive, active);

  /* 系统真旋转了（iOS 原生请求成功后），CSS 就不再转 90°；
     物理横置手机时自动进入全屏，竖回时自动退出全屏（对齐 LNPANDY 版）。 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          setFs(isLand);
          keepAlive();
          wake();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepAlive, wake]);

  /* 全屏切换或视口旋转后校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即把 scrollTop 对齐到 index * clientHeight，
       防止错位到其它视频封面（「横屏播放变成别的剧集」的根因）。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs || fullscreen) {
      el.scrollTop = 0;
      return undefined;
    }
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs || fullscreen) return;
      box.scrollTop = index * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [boxRef, fs, fullscreen, vpLandscape, index]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      closeFallbackFs();
      for (const t of keepAliveTimers.current) window.clearTimeout(t);
      keepAliveTimers.current = [];
    };
  }, [closeFallbackFs]);

  return {
    idsRef,
    index,
    renderIndex,
    fullscreen,
    vpLandscape,
    portraitFit,
    setPortraitFit,
    onScroll,
    go,
    stepDir,
    canStep,
    toggleFull,
    enterFs,
    exitFs,
  };
}

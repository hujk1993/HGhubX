import type { Dispatch, MutableRefObject, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { fmt, fmtTime } from "../../shared/api/api";
import type { Post } from "../../shared/api/types";
import type { Toast } from "../../shared/model/store";
import { PlaybackProgress, playbackLockRightInset, type PlaybackClock } from "../playback";
import {
  IBack, IChevR, IChevronDown, IChevronUp, IComment, IExpand, IFileText,
  IHeart, IHeartF, IList, ILockF, IMore, IPlayF, IStar, IStarF, IVertSwap, IVol, IVolMute,
} from "../../shared/ui/icons";
import { CurrentVideoTags } from "./CurrentVideoTags";
import { useTagHint } from "./useTagHint";
import type { FeedMeta } from "./useFeedActions";
import type { FeedPanel } from "./useFeedViewport";
import "../../styles/video-details.css";
import { tr } from "../../shared/i18n";

function MobileTagHint() {
  const tagHint = useTagHint();
  if (tagHint.dismissed) return null;
  return <div className="current-video-tags-hint">
    <span>{tr("点按查看同类 · 长按屏蔽")}</span>
    <Button type="button" className="current-video-tags-hint-dismiss"
      aria-label={tr("不再显示标签操作提示")} onClick={tagHint.dismiss}>{tr("不再显示")}</Button>
  </div>;
}

type Props = {
  isActive: boolean;
  isDesktop: boolean;
  fs: boolean;
  clean: boolean;
  controlsLocked: boolean;
  idle: boolean;
  rotated: boolean;
  mode: "home" | "context";
  kind: "video" | "post";
  title: string;
  index: number;
  effectiveLength: number;
  bottomInset: number;
  curEp: number;
  duration: number;
  meta: FeedMeta;
  post?: Post;
  hevcUrl: string;
  preferHevc: boolean;
  setPreferHevc: (v: boolean) => void;
  landscapeVideo: boolean;
  capsuleOn: boolean;
  zoom: { s: number; x: number; y: number; g: boolean };
  setZoom: Dispatch<SetStateAction<{ s: number; x: number; y: number; g: boolean }>>;
  liked: boolean;
  collected: boolean;
  likePending: boolean;
  collectPending: boolean;
  heartBurst: number;
  likeCount: number;
  collectCount: number;
  paused: boolean;
  onTogglePlay: () => void;
  waiting: boolean;
  err: string;
  scrub: { pct: number; target: number } | null;
  barRef: MutableRefObject<HTMLDivElement | null>;
  barPct: number | null;
  playbackClock: PlaybackClock;
  onBack?: () => void;
  enterFs: (landscape: boolean) => void;
  stepDir: (dir: number) => void;
  canStep: (dir: number) => boolean;
  onLike: () => Promise<void>;
  onFav: () => Promise<void>;
  setPanel: Dispatch<SetStateAction<FeedPanel>>;
  openTag: (tag: string) => void;
  openTagMenu: (selected?: string[]) => void;
  muted: boolean;
  onToggleMuted: () => void;
  swipeEnabled: boolean;
  swipeEp: boolean;
  onToggleSwipe: () => void;
  onLock: () => void;
  onBarDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onBarMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onBarUp: (e: ReactPointerEvent<HTMLDivElement>, cancelled?: boolean) => void;
  onRetryStream: () => void;
  toast: (msg: string, icon?: Toast["icon"]) => void;
};

export default function FeedItemChrome({
  isActive, isDesktop, fs, clean, controlsLocked, idle, rotated, mode, kind, title, index, effectiveLength, bottomInset,
  curEp, duration, meta, post, hevcUrl, preferHevc, setPreferHevc,
  landscapeVideo, capsuleOn, zoom, setZoom,
  liked, collected, likePending, collectPending, heartBurst, likeCount, collectCount,
  paused, onTogglePlay, waiting, err, scrub, barRef, barPct, playbackClock,
  onBack, enterFs, stepDir, canStep, onLike, onFav, setPanel, openTag, openTagMenu,
  muted, onToggleMuted, swipeEnabled, swipeEp, onToggleSwipe, onLock,
  onBarDown, onBarMove, onBarUp, onRetryStream, toast,
}: Props) {
  const episodes = meta.episodes;
  const activePct = barPct ?? (scrub ? scrub.pct / 100 : null);
  const scrubbing = isActive && activePct !== null;

  return (
    <>
      {/* 图文帖：没有视频就给个正文入口 */}
      {isActive && kind === "post" && !!post && !post.video_url && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Button type="button" onClick={() => setPanel("article")}
            className="flex items-center gap-2 h-11 px-5 rounded-full text-[14px] font-semibold pressable elev-3"
            style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
            <IFileText size={17} />{tr("查看图文详情")}</Button>
        </div>
      )}

      {/* 顶部 */}
      {!fs && !clean && mode === "context" ? (
        isDesktop ? (
          <div className="desktop-context-header">
            <Button onClick={onBack} aria-label={tr("返回")}><IBack size={17} /></Button>
            <span>{title}</span>
            <small>{index + 1} / {effectiveLength}</small>
          </div>
        ) : (
          <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5 pointer-events-none" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: 164 }}>
            <Button onClick={onBack} aria-label={tr("返回")} className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1 pointer-events-auto"><IBack size={20} /></Button>
            <span className="text-[15px] font-semibold hg-ink hg-ov-shadow truncate">{title}</span>
          </div>
        )
      ) : null}
      {!fs && !clean && !isDesktop && mode === "context" && (
        <span className="feed-position-pill absolute z-20 px-2.5 py-1 rounded-full hg-chip text-[12px] font-semibold tabular-nums"
          style={{ top: "calc(var(--sat, 0px) + 52px)", left: 12, color: "rgba(255,255,255,.94)" }}>
          {index + 1} / {effectiveLength}
        </span>
      )}
      {/* Fullscreen lock belongs to the auto-hiding control group; non-fullscreen clean mode keeps it visible. */}
      {!isDesktop && kind === "video" && !controlsLocked && (fs ? !idle : clean) && (
        <Button aria-label={tr("锁定屏幕")} title={tr("锁定屏幕")} onClick={onLock} className="mobile-clean-lock"
          style={{ right: playbackLockRightInset(rotated, fs) }}>
          <ILockF size={19} />
        </Button>
      )}

      {/* Pinch-zoom reset stays available; fill and rotate shortcuts are intentionally removed
          because fill lives in playback settings and fullscreen has its own bottom-right control. */}
      {!isDesktop && isActive && capsuleOn && zoom.s > 1.05 && (
        <div className="absolute z-30"
          style={{
            right: "calc(var(--sar, 0px) + 12px)",
            top: "calc(var(--sat, 0px) + 56px)",
          }}>
          <div className="flex flex-col items-stretch gap-1 p-1 rounded-[18px] backdrop-blur-xl elev-2"
            style={{ background: "rgba(12,15,22,.58)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.09)" }}>
            <Button type="button" onClick={() => setZoom({ s: 1, x: 0, y: 0, g: false })}
              className="whitespace-nowrap flex items-center justify-center gap-1 min-h-0 h-[26px] px-3 rounded-full text-[12px] font-semibold pressable transition-colors duration-150"
              style={{ color: "rgba(255,255,255,.9)" }}>{tr("还原 {0}x", zoom.s.toFixed(1))}</Button>
          </div>
        </div>
      )}

      {/* Mobile social actions and the playback settings entry. */}
      {!fs && !clean && !isDesktop && (
        <div className="mobile-video-action-rail absolute z-30 flex flex-col items-center gap-[10px]"
          style={{ right: "calc(var(--sar, 0px) + 12px)", bottom: `calc(var(--sab, 0px) + ${bottomInset}px + var(--mobile-action-rail-clearance, 108px))` }}>
          <Button onClick={() => void onLike()} disabled={likePending} aria-busy={likePending} className="mobile-action-like flex flex-col items-center gap-1 pressable" aria-pressed={liked} aria-label={tr("点赞")}>
            {liked ? <IHeartF size={27} className="text-neon" /> : <IHeart size={27} className="hg-ink hg-ov-shadow" />}
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
          </Button>
          <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} className="mobile-action-favorite flex flex-col items-center gap-1 pressable" aria-pressed={collected} aria-label={tr("收藏")}>
            {collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectCount)}</span>
          </Button>
          <Button onClick={() => setPanel("comments")} className="mobile-action-comments flex flex-col items-center gap-1 pressable" aria-label={tr("评论 {0} 条", fmt(meta.comment))}>
            <IComment size={27} className="hg-ink hg-ov-shadow" />
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
          </Button>
          <Button onClick={() => setPanel("more")} className="mobile-action-more flex flex-col items-center gap-1 pressable" aria-label={tr("更多播放设置")}>
            <IMore size={26} className="hg-ink hg-ov-shadow" />
            <span className="text-[12px] hg-ink-2 hg-ov-shadow">{tr("更多")}</span>
          </Button>
        </div>
      )}

      {/* 右侧操作栏（桌面） */}
      {!fs && !clean && isDesktop && (
        <div className="absolute z-20 flex flex-col items-center desktop-social">
          <div className="desktop-browse-inline">
            <Button onClick={() => stepDir(-1)} disabled={!canStep(-1)} aria-label={tr("上一个")} title={tr("上一个 ↑")}>
              <IChevronUp size={19} strokeWidth={1.8} />
            </Button>
            <Button onClick={() => stepDir(1)} disabled={!canStep(1)} aria-label={tr("下一个")} title={tr("下一个 ↓")}>
              <IChevronDown size={19} strokeWidth={1.8} />
            </Button>
            <small>{String(index + 1).padStart(2, "0")} / {String(effectiveLength).padStart(2, "0")}</small>
          </div>

          <Button onClick={() => void onLike()} disabled={likePending} aria-busy={likePending} aria-label={tr("点赞")} className="flex flex-col items-center gap-1 pressable" aria-pressed={liked}>
            <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
              {liked ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
            </span>
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
          </Button>

          <Button onClick={() => setPanel("comments")} aria-label={tr("评论 {0} 条", fmt(meta.comment))} className="flex flex-col items-center gap-1 pressable">
            <IComment size={27} className="text-white tsh" />
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
          </Button>

          <Button onClick={() => void onFav()} disabled={collectPending} aria-busy={collectPending} aria-label={tr("收藏")} className="flex flex-col items-center gap-1 pressable" aria-pressed={collected}>
            {collected ? <IStarF size={27} className="hg-gold" /> : <IStar size={27} className="hg-ink hg-ov-shadow" />}
            <span className="text-[12px] text-white/90 tabular-nums">{fmt(collectCount)}</span>
          </Button>

          {kind === "video" && (
            <Button onClick={() => setPanel("episodes")} aria-label={tr("选集")} className="flex flex-col items-center gap-1 pressable">
              <IList size={26} className="text-white tsh" />
              <span className="text-[12px] text-white/90">{tr("选集")}</span>
            </Button>
          )}
        </div>
      )}

      {/* 桌面：左下信息 */}
      {!fs && !clean && isDesktop && (
        <div className="desktop-video-meta">
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-bold text-white tsh truncate">@{meta.author}</span>
            {episodes.length > 0 && (
              <span className="shrink-0 px-1.5 py-px rounded-md text-[12px] font-bold text-white"
                style={{ background: "rgba(255,255,255,.16)" }}>{tr("第 {0}/{1} 集", curEp, episodes.length)}</span>
            )}
            {hevcUrl && (
              <Button type="button" aria-pressed={preferHevc}
                onClick={() => { setPreferHevc(!preferHevc); toast(preferHevc ? tr("已切回标准画质") : tr("已切换高清 HEVC"), "ok"); }}
                className={`shrink-0 min-h-0 h-[18px] px-1.5 rounded-md text-[12px] font-bold flex items-center pressable transition-colors ${preferHevc ? "bg-white text-[#191919]" : "text-white border border-white/30"}`}>
                {preferHevc ? "HD" : tr("标清")}
              </Button>
            )}
            {!!meta.score && (
              <span className="shrink-0 text-[12px] font-bold hg-gold hg-ov-shadow">{tr("{0} 分", meta.score.toFixed(1))}</span>
            )}
          </div>

          <p className="mt-1 text-[14px] leading-snug hg-ink-2 hg-ov-shadow clamp-2">{meta.title}</p>

          <p className="mt-1 text-[12px] leading-relaxed hg-ink-4 clamp-1">{meta.desc || tr("暂无简介")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button aria-label={tr("视频详情")} onClick={() => setPanel("detail")} className="min-h-11 px-4 rounded-full hg-chip text-[12px] inline-flex items-center gap-1">{tr("详情与标签")}<IChevR size={13} />
            </Button>
          </div>
        </div>
      )}

      {/* 移动端：标题 + 详情标签 + 底部进度条（横拖画面或直拖底栏时统一突出显示下方进度条，不在屏幕中央叠进度条） */}
      {!fs && !isDesktop && (!clean || scrubbing) && (
        <div className="absolute inset-x-0 z-20 pointer-events-none" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)` }}>
          {!clean && (
            <div className={`mobile-video-meta-copy relative pb-1 flex items-center gap-2 transition-opacity duration-150 ${scrubbing ? "opacity-35" : ""}`}>
              <div className="flex-1 min-w-0">
                {!!meta.author && <div className="mobile-video-author">@{meta.author}</div>}
                <p className="text-[15px] font-semibold leading-snug hg-ink-2 hg-ov-shadow-strong clamp-2">{meta.title}</p>
                {kind === "video" && <div className="mobile-video-episode">{tr("第{0}集", curEp)}</div>}
                <CurrentVideoTags tags={meta.tags} onOpen={openTag} onBlock={tag => openTagMenu([tag])} />
                {meta.tags.length > 0 && <MobileTagHint />}
              </div>
            </div>
          )}
          <div className="relative pt-1.5 pb-2.5">
            {isActive && <div ref={barRef} data-seek-bar data-scrubbing={scrubbing || undefined}
              className="-mt-0.5 -mb-2.5 relative pointer-events-auto"
              style={{
                height: 36,
                touchAction: "none",
                marginLeft: "calc(var(--sal, 0px) + 16px)",
                marginRight: "calc(var(--sar, 0px) + 16px)",
              }}
              onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={(e) => onBarUp(e, false)} onPointerCancel={(e) => onBarUp(e, true)}>
              <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full overflow-hidden"
                style={{
                  height: scrubbing ? 6 : 2,
                  background: scrubbing ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.14)",
                  boxShadow: scrubbing ? "0 2px 10px rgba(0,0,0,.48)" : "none",
                  transition: "height .16s cubic-bezier(.2,0,0,1), background-color .16s ease, box-shadow .16s ease",
                }}>
                <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} className="h-full rounded-full"
                  style={{
                    background: scrubbing ? "#fff" : "rgba(255,255,255,.32)",
                    boxShadow: scrubbing ? "0 0 10px rgba(255,255,255,.55)" : "none",
                    transition: scrubbing ? "none" : "width .25s linear, background-color .16s ease",
                  }} />
              </div>
              <PlaybackProgress clock={playbackClock} duration={duration} preview={activePct} position
                className="absolute top-1/2 rounded-full bg-white pointer-events-none"
                style={{
                  width: scrubbing ? 14 : 7,
                  height: scrubbing ? 14 : 7,
                  transform: "translate(-50%, -50%)",
                  boxShadow: scrubbing ? "0 0 0 4px rgba(255,255,255,.24), 0 2px 8px rgba(0,0,0,.6)" : "0 0 8px rgba(0,0,0,.55)",
                  transition: scrubbing ? "width .14s ease, height .14s ease, box-shadow .14s ease" : "left .25s linear, width .14s ease, height .14s ease, box-shadow .14s ease",
                }} />
              {scrubbing && activePct !== null && (
                <div className="absolute left-1/2 -translate-x-1/2 -top-9 px-3 py-1 rounded-full hg-chip-strong backdrop-blur-md text-[13px] font-bold tabular-nums whitespace-nowrap pointer-events-none elev-2"
                  style={{ boxShadow: "0 4px 16px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.14)" }}>
                  <span className="text-white">{fmtTime(activePct * (duration || 0))}</span>
                  <span className="hg-ink-4 font-medium"> / {fmtTime(duration)}</span>
                </div>
              )}
            </div>}
            {!clean && <div className={mode === "home" && kind === "video" ? "mobile-playback-dock mobile-playback-dock-home" : "mobile-playback-dock"}>
              {kind === "video" ? <Button aria-label={episodes.length ? tr("选集，共 {0} 集", episodes.length) : tr("选集")} onClick={() => setPanel("episodes")} className="mobile-playback-episodes">
                <IList size={18} /><span>{tr("选集{0}", episodes.length > 0 ? tr(" · 全{0}集", episodes.length) : "")}</span><IChevronUp size={16} />
              </Button> : <Button aria-label={tr("图文详情")} onClick={() => setPanel("detail")} className="mobile-playback-episodes">
                <IFileText size={18} /><span>{tr("图文详情")}</span><IChevronUp size={16} />
              </Button>}
              <Button onClick={onToggleMuted} aria-label={muted ? tr("取消静音") : tr("静音")} aria-pressed={muted}
                className="mobile-playback-quick">
                {muted ? <IVolMute size={18} /> : <IVol size={18} />}
              </Button>
              {swipeEnabled && <Button onClick={onToggleSwipe} aria-label={swipeEp ? tr("关闭上下划切集") : tr("开启上下划切集")} aria-pressed={swipeEp}
                className={`mobile-playback-quick ${swipeEp ? "is-on" : ""}`}>
                <IVertSwap size={18} />
              </Button>}
              <Button aria-label={tr("全屏")} onClick={() => enterFs(landscapeVideo)} className="mobile-playback-fullscreen"><IExpand size={19} /></Button>
            </div>}
          </div>
        </div>
      )}

      {/* 暂停 / 缓冲 */}
      {isActive && paused && !err && !scrubbing && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <Button type="button" aria-label={tr("播放")} onClick={onTogglePlay}
            className="w-[66px] h-[66px] rounded-full flex items-center justify-center backdrop-blur-md pointer-events-auto pressable"
            style={{ background: "rgba(0,0,0,.55)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,.12)" }}>
            <IPlayF size={28} className="hg-ink ml-0.5" />
          </Button>
        </div>
      )}
      {isActive && waiting && !err && !paused && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><Loader className="w-9 h-9 spinner" /></div>
      )}
      {isActive && err && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[14px] hg-ink-2 pointer-events-auto" style={{ background: "rgba(0,0,0,.7)" }}>
            <span>{tr("视频暂时无法加载")}</span>
            <span className="text-[12px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
            <Button className="hg-link text-[14px]" onClick={onRetryStream}>{tr("重试")}</Button>
          </div>
        </div>
      )}
    </>
  );
}

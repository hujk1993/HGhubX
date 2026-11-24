import { Button, Surface } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, TopicCard, TopicDetail, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, useContentPreferences } from "../../shared/model/contentPreferences";
import { AUTO_LOAD_EMPTY_PAGE_LIMIT, useAutoLoadMore } from "../../shared/lib/useAutoLoadMore";
import { Masonry, MediaCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty, Img } from "../../shared/ui/ui";
import { IBack, IFireF, ILayers, IRefresh, ISearch, ITag } from "../../shared/ui/icons";
import { tr } from "../../shared/i18n";
import { VideoSortMenu } from "../../shared/ui/VideoSortMenu";
import { sortVideosByMetric, type VideoSortDirection, type VideoSortMetric } from "../../shared/model/videoSort";

const TopicIcon = ILayers;
const TagIcon = ITag;
const TAG_METRIC_PAGE_SIZE = 100;
const TAG_METRIC_MAX_PAGES = 30;

/** Retain the last good result on refresh, but never expose a previous route's data. */
function useDiscoveryData<T>(baseKey: string, request: () => Promise<T>) {
  const { lineEpoch } = useStore();
  const key = `${lineEpoch}:${baseKey}`;
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string }>({ key, data: null, loading: true, error: "" });
  const sequence = useRef(0);
  const busy = useRef(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const token = ++sequence.current;
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: "" }));
    try {
      const data = await requestRef.current();
      if (token === sequence.current) setState({ key, data, loading: false, error: "" });
    } catch (error) {
      if (token === sequence.current) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : tr("加载失败，请重试") }));
    } finally {
      if (token === sequence.current) busy.current = false;
    }
  }, [key]);
  useEffect(() => {
    busy.current = false;
    void load();
    return () => { sequence.current++; busy.current = false; };
  }, [load]);
  return { data: state.key === key ? state.data : null, loading: state.key !== key || state.loading, err: state.key === key ? state.error : "", load };
}

function RefreshStatus({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (!loading && !error) return null;
  return <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut">
    {loading ? <><Loader className="w-4 h-4" />{tr("正在刷新，保留当前内容…")}</>
      : <><span className="min-w-0 break-words">{tr("刷新失败，保留当前内容。{0}", error)}</span><Button onClick={onRetry} className="px-3 text-primary">{tr("重试")}</Button></>}
  </div>;
}

/* ================= 专题列表页 ================= */
export function TopicsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const { data, loading, err, load } = useDiscoveryData("topics", api.topics);
  const items = data?.items ?? [];

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><TopicIcon size={18} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight">{tr("专题")}</h1>
            <div className="text-[12px] text-mut leading-tight mt-0.5">{loading && !items.length ? tr("加载中…") : tr("{0} 个专辑", items.length)}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={tr("搜索短剧")} className="ios-nav-btn"><ISearch size={18} /></Button>
          <Button aria-label={tr("刷新")} disabled={loading} aria-busy={loading} onClick={() => void load()} className="ios-nav-btn">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={18} />}</Button>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {items.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
        {loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title={tr("专题加载失败")} sub={err} action={tr("重试")} onAction={load} />
        ) : items.length ? (
          <div className={`grid gap-3.5 ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"}`}>
            {items.map((t) => (
              <Button key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}
                title={t.title} className="ios-topic-card min-w-0 text-left pressable a-rise">
                <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
                  <Img src={t.cover} />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                  <span className="absolute bottom-2 left-2.5 inline-flex items-center h-6 px-2.5 rounded-full bg-black/62 border border-white/15 backdrop-blur-sm text-[11.5px] font-semibold text-white/95 tabular-nums">{tr("{0} 部", t.video_count ?? 0)}</span>
                </div>
                <div className="px-3 py-2.5">
                  <div className="text-[14px] font-semibold text-on clamp-1 leading-snug">{t.title}</div>
                </div>
              </Button>
            ))}
          </div>
        ) : (
          <Empty icon={<TopicIcon size={26} />} title={tr("暂无专题")} />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索 · 专题") })} />}
    </div>
  );
}

/* ================= 专题详情页 ================= */
export function TopicPage({ slug, name, onBack, wide }: { slug: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const blockReasonRef = useRef(blockReason);
  blockReasonRef.current = blockReason;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const [searching, setSearching] = useState(false);
  const [introExpanded, setIntroExpanded] = useState(false);
  const [emptyStreak, setEmptyStreak] = useState(0);
  const introId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{
    topic: TopicDetail["topic"] | null;
    related: TopicCard[];
    videos: VideoCard[];
    page: number;
    pages: number;
    total: number;
    loading: boolean;
    loadingMore: boolean;
    error: string;
  }>({ topic: null, related: [], videos: [], page: 0, pages: 1, total: 0, loading: true, loadingMore: false, error: "" });
  const sequence = useRef(0);
  const busy = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const load = useCallback(async (page = 1, reset = false) => {
    if (busy.current) return;
    busy.current = true;
    const token = reset ? ++sequence.current : sequence.current;
    if (reset) setEmptyStreak(0);
    setState(previous => reset
      ? { ...previous, topic: null, related: [], videos: [], page: 0, pages: 1, total: 0, loading: true, loadingMore: false, error: "" }
      : { ...previous, loading: false, loadingMore: true, error: "" });
    try {
      const data = await api.topic(slug, page, 20);
      if (token !== sequence.current) return;
      const incoming = data?.videos?.items ?? [];
      if (filteringRef.current && incoming.length > 0) {
        const visibleCount = incoming.filter(video => !blockReasonRef.current(video.tags)).length;
        setEmptyStreak(prev => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
      } else {
        setEmptyStreak(0);
      }
      setState(previous => {
        const seen = new Set(reset ? [] : previous.videos.map(video => video.id));
        const videos = [...(reset ? [] : previous.videos), ...incoming.filter(video => !seen.has(video.id))];
        return {
          topic: data?.topic ?? previous.topic,
          related: data?.related ?? previous.related,
          videos,
          page: data?.videos?.pagination?.page ?? page,
          pages: Math.max(1, data?.videos?.pagination?.pages ?? page),
          total: Math.max(videos.length, data?.videos?.pagination?.total ?? videos.length),
          loading: false,
          loadingMore: false,
          error: "",
        };
      });
    } catch (error) {
      if (token === sequence.current) {
        setState(previous => ({
          ...previous,
          loading: false,
          loadingMore: false,
          error: error instanceof Error ? error.message : tr("加载失败，请重试"),
        }));
      }
    } finally {
      if (token === sequence.current) busy.current = false;
    }
  }, [slug, lineEpoch]);

  const loadMore = () => {
    const current = stateRef.current;
    if (current.loading || current.loadingMore || current.page >= current.pages) return;
    void load(current.page + 1);
  };

  useEffect(() => {
    busy.current = false;
    setIntroExpanded(false);
    setSearching(false);
    void load(1, true);
    return () => { sequence.current++; busy.current = false; };
  }, [load]);

  const { topic, related, videos, page, pages, total, loading, loadingMore, error } = state;
  const hasMore = page < pages;
  useEffect(() => { setEmptyStreak(0); }, [filtering, preferences.blockedTags, preferences.hideUntagged]);
  const autoLoadPaused = filtering && emptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT;

  useAutoLoadMore({
    scrollRef,
    sentinelRef,
    enabled: !loading && !loadingMore && !error && hasMore && !autoLoadPaused,
    watchKey: `${page}:${pages}:${videos.length}`,
    onLoadMore: loadMore,
    rootMargin: "260px",
  });

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate" title={topic?.title || name}>{topic?.title || name}</h1>
            <div className="text-[12px] text-mut leading-tight mt-0.5">{loading ? tr("加载中…") : tr("已加载 {0} / {1} 部", videos.length, total)}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={tr("搜索短剧")} className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {topic?.intro && <section className="mb-4" aria-label={tr("专题简介")}>
          <p id={introId} className={`text-[13px] text-mut leading-relaxed break-words ${introExpanded ? "" : "clamp-3"}`}>{topic.intro}</p>
          <Button aria-expanded={introExpanded} aria-controls={introId} onClick={() => setIntroExpanded(value => !value)} className="mt-1 inline-flex items-center min-h-9 px-0 text-[12px] font-medium text-primary">{introExpanded ? tr("收起简介") : tr("展开简介")}</Button>
        </section>}
        {related.length > 0 && (
          <div className="mb-5">
            <h2 className="text-[13.5px] font-bold text-on/90 mb-2.5">{tr("相关专题")}</h2>
            <div className="scroll-x flex gap-3 snap-x">
              {related.map((r) => (
                <Button key={r.id} onClick={() => push({ kind: "topic", slug: r.slug, name: r.title })}
                  className="ios-topic-card w-[156px] shrink-0 text-left snap-start pressable">
                  <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
                    <Img src={r.cover} />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
                    <span className="absolute bottom-1.5 left-2 inline-flex items-center h-5 px-2 rounded-full bg-black/62 border border-white/15 text-[11px] font-semibold text-white/95 tabular-nums">{tr("{0} 部", r.video_count ?? 0)}</span>
                  </div>
                  <div className="px-2.5 py-2">
                    <div className="text-[12.5px] font-semibold text-on clamp-1 leading-snug">{r.title}</div>
                  </div>
                </Button>
              ))}
            </div>
          </div>
        )}

        {loading && !videos.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : error && !videos.length ? (
          <Empty icon={<TopicIcon size={26} />} title={tr("加载失败")} sub={error} action={tr("重试")} onAction={() => void load(1, true)} />
        ) : videos.length ? (
          <Masonry videos={videos} scopeKey={slug} wide={wide} onOpen={(v, visible) => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: topic?.title || name })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title={tr("暂无内容")} />
        )}
        {error && videos.length > 0 && <div role="alert" className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 break-words">{tr("加载更多失败：{0}", error)}</span>
          <Button disabled={loadingMore} onClick={loadMore} className="px-3 text-primary">{tr("重试")}</Button>
        </div>}
        {loadingMore && <div className="flex justify-center py-3"><Loader label={tr("正在加载更多专题影片")} className="w-6 h-6" /></div>}
        {!loading && !loadingMore && !error && hasMore && autoLoadPaused && <Button onClick={() => { setEmptyStreak(0); loadMore(); }} className="mt-3 w-full rounded-(--r-ctl) bg-s3 py-2.5 text-[13px] text-on pressable">{tr("加载更多（{0}/{1}）", videos.length, total)}</Button>}
        {!loading && !loadingMore && !hasMore && videos.length > 0 && <div className="py-3 text-center text-[12px] text-dim">{tr("已加载全部 {0} 部", total)}</div>}
        <div ref={sentinelRef} className="h-6" aria-hidden="true" />
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索") })} />}
    </div>
  );
}

/* ================= 标签聚合页 ================= */
export function TagsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const { data, loading, err, load } = useDiscoveryData("tags", api.tags);
  const groups = data?.categories ?? [];

  const totalTags = groups.reduce((sum, g) => sum + (g.tags?.length || 0), 0);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><TagIcon size={18} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight">{tr("标签")}</h1>
            <div className="text-[12px] text-mut leading-tight mt-0.5">{loading && !groups.length ? tr("加载中…") : tr("{0} 个标签 · {1} 组", totalTags, groups.length)}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={tr("搜索短剧")} className="ios-nav-btn"><ISearch size={18} /></Button>
          <Button aria-label={tr("刷新")} disabled={loading} aria-busy={loading} onClick={() => void load()} className="ios-nav-btn">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={18} />}</Button>
        </div>
      </div>

      <div className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {groups.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
        {loading && !groups.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !groups.length ? (
          <Empty icon={<TagIcon size={26} />} title={tr("标签加载失败")} sub={err} action={tr("重试")} onAction={load} />
        ) : groups.length ? (
          <div className={`grid gap-3.5 ${wide ? "grid-cols-2" : "grid-cols-1"}`}>{groups.map((g) => (
            <Surface key={g.name} className="rounded-[22px] bg-s1 p-4 a-rise">
              <div className="flex items-baseline justify-between gap-2 mb-3">
                <h2 className="text-[14.5px] font-bold text-on">{g.name}</h2>
                <span className="text-[12px] text-dim tabular-nums">{tr("{0} 个", g.tags?.length || 0)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {g.tags.map((t) => (
                  <Button key={t.id} onClick={() => push({ kind: "tag", tag: t.name, name: t.name })}
                    className="ios-filter-pill max-w-full min-w-0 gap-1.5 text-left">
                    <span className="min-w-0 whitespace-normal break-words text-on/95">{t.name}</span>
                    {!!t.hot_score && <span aria-label={tr("热度 {0}", fmt(t.hot_score))} className="shrink-0 inline-flex items-center gap-0.5 text-[11.5px] font-medium text-dim tabular-nums"><IFireF size={11} className="text-primary/85" />{fmt(t.hot_score)}</span>}
                  </Button>
                ))}
              </div>
            </Surface>
          ))}</div>
        ) : (
          <Empty icon={<TagIcon size={26} />} title={tr("暂无标签")} />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索 · 标签") })} />}
    </div>
  );
}

/* ================= 标签视频页 ================= */
export function TagPage({ tag, name, onBack, wide }: { tag: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { preferences, storageError, isTagBlocked, blockTags, unblockTag, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const blockReasonRef = useRef(blockReason);
  blockReasonRef.current = blockReason;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const tagBlocked = isTagBlocked(name);
  const cannotAdd = !name.trim() || name.trim().length > MAX_TAG_LENGTH || preferences.blockedTags.length >= MAX_BLOCKED_TAGS;
  const [searching, setSearching] = useState(false);
  const [videos, setVideos] = useState<VideoCard[]>([]);
  const [metricSort, setMetricSort] = useState<VideoSortMetric>("default");
  const [metricDirection, setMetricDirection] = useState<VideoSortDirection>("desc");
  const [metricVisible, setMetricVisible] = useState(20);
  const metricLoaded = useRef(false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [videoPage, setVideoPage] = useState(0);
  const [postPage, setPostPage] = useState(0);
  const [videoPages, setVideoPages] = useState(1);
  const [postPages, setPostPages] = useState(1);
  const [videoTotal, setVideoTotal] = useState(0);
  const [postTotal, setPostTotal] = useState(0);
  const [videoLoading, setVideoLoading] = useState(true);
  const [postLoading, setPostLoading] = useState(true);
  const [videoErr, setVideoErr] = useState("");
  const [postErr, setPostErr] = useState("");
  const [videoEmptyStreak, setVideoEmptyStreak] = useState(0);
  const [postEmptyStreak, setPostEmptyStreak] = useState(0);
  const [loadedVideoTag, setLoadedVideoTag] = useState("");
  const [loadedPostTag, setLoadedPostTag] = useState("");
  const busy = useRef({ video: false, post: false });
  const sequence = useRef({ video: 0, post: 0 });
  const videoSentinel = useRef<HTMLDivElement>(null);
  const postSentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const currentVideos = loadedVideoTag === tag;
  const currentPosts = loadedPostTag === tag;
  const sortedVideos = useMemo(
    () => currentVideos ? sortVideosByMetric(videos, metricSort, metricDirection) : [],
    [currentVideos, videos, metricSort, metricDirection],
  );
  const visibleVideos = metricSort === "default" ? sortedVideos : sortedVideos.slice(0, metricVisible);
  const visiblePosts = currentPosts ? posts : [];

  const loadMetricVideos = async (metric: VideoSortMetric) => {
    if (metric === "default") return;
    busy.current.video = true;
    const token = ++sequence.current.video;
    setVideoLoading(true);
    setVideoErr("");
    setVideoEmptyStreak(0);
    setMetricVisible(20);
    let all: VideoCard[] = [];
    let totalPages = 1;
    let requestedPages = 1;
    try {
      const first = await api.tagVideos(tag, 1, TAG_METRIC_PAGE_SIZE);
      if (sequence.current.video !== token) return;
      totalPages = Math.max(1, first?.pagination?.pages || 1);
      requestedPages = Math.min(totalPages, TAG_METRIC_MAX_PAGES);
      all = first?.items ?? [];
      for (let start = 2; start <= requestedPages; start += 4) {
        const batch: Promise<Awaited<ReturnType<typeof api.tagVideos>>>[] = [];
        for (let p = start; p < Math.min(start + 4, requestedPages + 1); p += 1) {
          batch.push(api.tagVideos(tag, p, TAG_METRIC_PAGE_SIZE));
        }
        const results = await Promise.all(batch);
        if (sequence.current.video !== token) return;
        for (const result of results) all.push(...(result?.items ?? []));
      }
      if (sequence.current.video !== token) return;
      const seen = new Set<number>();
      const unique = all.filter(item => !seen.has(item.id) && !!seen.add(item.id));
      setVideos(unique);
      setLoadedVideoTag(tag);
      setVideoPage(requestedPages);
      setVideoPages(totalPages);
      setVideoTotal(first?.pagination?.total || unique.length);
      metricLoaded.current = true;
    } catch (error) {
      if (sequence.current.video !== token) return;
      if (all.length) {
        const seen = new Set<number>();
        setVideos(all.filter(item => !seen.has(item.id) && !!seen.add(item.id)));
        setLoadedVideoTag(tag);
        setVideoPage(requestedPages);
        setVideoPages(totalPages);
      }
      const message = error instanceof Error ? error.message : tr("加载失败，请重试");
      setVideoErr(message);
    } finally {
      if (sequence.current.video === token) {
        busy.current.video = false;
        setVideoLoading(false);
      }
    }
  };

  const load = useCallback(async (kind: "video" | "post", next: number, reset = false) => {
    if (busy.current[kind] && !reset) return;
    busy.current[kind] = true;
    const token = ++sequence.current[kind];
    if (kind === "video") { setVideoLoading(true); setVideoErr(""); if (reset) setVideoEmptyStreak(0); }
    else { setPostLoading(true); setPostErr(""); if (reset) setPostEmptyStreak(0); }
    try {
      if (kind === "video") {
        const result = await api.tagVideos(tag, next, 20);
        if (sequence.current.video !== token) return;
        const incoming = result?.items ?? [];
        setVideos(previous => {
          const base = reset ? [] : previous;
          const seen = new Set(base.map(item => item.id));
          return [...base, ...incoming.filter(item => !seen.has(item.id))];
        });
        if (filteringRef.current && incoming.length > 0) {
          const visibleCount = incoming.filter(item => !blockReasonRef.current(item.tags)).length;
          setVideoEmptyStreak(prev => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
        } else {
          setVideoEmptyStreak(0);
        }
        setLoadedVideoTag(tag); setVideoPage(next); setVideoPages(result?.pagination?.pages || next); setVideoTotal(result?.pagination?.total || 0);
      } else {
        const result = await api.postTag(name, next, 20);
        if (sequence.current.post !== token) return;
        const incoming = result?.items ?? [];
        setPosts(previous => {
          const base = reset ? [] : previous;
          const seen = new Set(base.map(item => item.id));
          return [...base, ...incoming.filter(item => !seen.has(item.id))];
        });
        if (filteringRef.current && incoming.length > 0) {
          const visibleCount = incoming.filter(item => !blockReasonRef.current(item.tags)).length;
          setPostEmptyStreak(prev => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
        } else {
          setPostEmptyStreak(0);
        }
        setLoadedPostTag(tag); setPostPage(next); setPostPages(result?.pagination?.pages || next); setPostTotal(result?.pagination?.total || 0);
      }
    } catch (error) {
      if (sequence.current[kind] === token) {
        const message = error instanceof Error ? error.message : tr("加载失败，请重试");
        if (kind === "video") setVideoErr(message); else setPostErr(message);
      }
    } finally {
      if (sequence.current[kind] === token) {
        busy.current[kind] = false;
        if (kind === "video") setVideoLoading(false); else setPostLoading(false);
      }
    }
  }, [tag, name]);
  const changeMetricSort = (value: VideoSortMetric, direction: VideoSortDirection = "desc") => {
    if (value === metricSort && direction === metricDirection) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setMetricVisible(20);
    if (value === "default") {
      metricLoaded.current = false;
      setMetricSort("default");
      setMetricDirection("desc");
      setVideos([]); setLoadedVideoTag(""); setVideoPage(0); setVideoPages(1); setVideoTotal(0);
      void load("video", 1, true);
      return;
    }
    const metricChanged = value !== metricSort;
    setMetricSort(value);
    setMetricDirection(direction);
    if (!metricChanged) return;
    if (metricLoaded.current) return;
    void loadMetricVideos(value);
  };
  useEffect(() => {
    sequence.current.video++; sequence.current.post++;
    busy.current.video = false; busy.current.post = false;
    setVideos([]); setPosts([]); setLoadedVideoTag(""); setLoadedPostTag("");
    setMetricSort("default"); setMetricDirection("desc"); setMetricVisible(20); metricLoaded.current = false;
    setVideoPage(0); setPostPage(0); setVideoPages(1); setPostPages(1); setVideoTotal(0); setPostTotal(0);
    setVideoLoading(true); setPostLoading(true); setVideoErr(""); setPostErr(""); setSearching(false);
    setVideoEmptyStreak(0); setPostEmptyStreak(0);
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    void load("video", 1, true);
    void load("post", 1, true);
    return () => { sequence.current.video++; sequence.current.post++; busy.current.video = false; busy.current.post = false; };
  }, [load, tag, lineEpoch]);
  useEffect(() => { setVideoEmptyStreak(0); setPostEmptyStreak(0); }, [filtering, preferences.blockedTags, preferences.hideUntagged]);
  const videoAutoLoadPaused = filtering && videoEmptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT;
  const postAutoLoadPaused = filtering && postEmptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT;
  useAutoLoadMore({
    scrollRef: scrollContainer,
    sentinelRef: videoSentinel,
    enabled: !videoErr && !videoLoading
      && (metricSort === "default" ? videoPage < videoPages && !videoAutoLoadPaused : metricVisible < sortedVideos.length),
    watchKey: `${videoPage}:${videoPages}:${videos.length}:${metricSort}:${metricDirection}:${metricVisible}`,
    onLoadMore: () => {
      if (metricSort !== "default") {
        setMetricVisible(count => Math.min(count + 20, sortedVideos.length));
      } else {
        void load("video", videoPage + 1);
      }
    },
    rootMargin: "300px",
  });
  useAutoLoadMore({
    scrollRef: scrollContainer,
    sentinelRef: postSentinel,
    enabled: !postErr && !postLoading && postPage < postPages && !postAutoLoadPaused,
    watchKey: `${postPage}:${postPages}:${posts.length}`,
    onLoadMore: () => { void load("post", postPage + 1); },
    rootMargin: "300px",
  });

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><TagIcon size={18} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate" title={name}>{name}</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5 tabular-nums">{tr("短剧 {0} · 吃瓜 {1}", currentVideos ? videoTotal : 0, currentPosts ? postTotal : 0)}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={tr("搜索短剧")} className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={videoLoading || postLoading || !currentVideos || !currentPosts}>
        <Surface className="mb-4 rounded-[20px] px-3.5 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="min-w-0 text-[13px] text-mut">{tagBlocked ? tr("此标签已加入屏蔽列表") : tr("标签筛选偏好")}</p>
            <div className="flex items-center gap-1.5 ml-auto">
              <Button className="inline-flex items-center min-h-10 px-2.5 text-[12.5px] font-medium text-mut hover:text-on"
                onClick={() => push({ kind: "settings", section: "内容偏好" })}>{tr("管理屏蔽标签")}</Button>
              <Button style={{ minBlockSize: 40 }} disabled={!tagBlocked && cannotAdd} aria-pressed={tagBlocked}
                onClick={() => tagBlocked ? unblockTag(name) : blockTags([name])}
                className={`inline-flex items-center justify-center min-h-10 rounded-(--r-ctl) px-3.5 text-[13px] font-semibold ${tagBlocked ? "bg-pc text-on-pc" : "bg-s3 text-primary"}`}>{tagBlocked ? tr("取消屏蔽此标签") : tr("屏蔽此标签")}</Button>
            </div>
          </div>
          {preferences.paused && <p role="status" className="mt-2 text-[12px] text-mut">{tr("屏蔽已暂停，新增标签会保存，恢复后生效。")}</p>}
          {!tagBlocked && cannotAdd && <p role="status" className="mt-2 text-[12px] text-mut">{name.trim().length > MAX_TAG_LENGTH ? tr("标签过长，请在内容偏好中管理。") : tr("已达到 {0} 个标签上限。", MAX_BLOCKED_TAGS)}</p>}
          {storageError && <p role="alert" className="mt-2 text-[13px] text-danger">{storageError}</p>}
        </Surface>
        {videoLoading && !visibleVideos.length && <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>}
        {videoErr && !visibleVideos.length && <Empty icon={<TagIcon size={26} />} title={tr("短剧加载失败")} sub={videoErr} action={tr("重试")} onAction={() => void (metricSort === "default" ? load("video", 1, true) : loadMetricVideos(metricSort))} />}
        {visibleVideos.length > 0 && <section className="mb-6">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-[15px] font-bold text-on">{tr("短剧")}</h2>
            <span className="text-[12px] text-mut tabular-nums">{videoTotal}</span>
            <VideoSortMenu className="ml-auto" value={metricSort} direction={metricDirection} onChange={changeMetricSort} />
          </div>
          <Masonry videos={visibleVideos} scopeKey={`tag-video:${tag}:${metricSort}:${metricDirection}`} wide={wide} onOpen={(v, visible) => push({ kind: "feed", videoIds: visible.map(x => x.id), index: visible.findIndex(x => x.id === v.id), title: name })} />
        </section>}
        <div ref={videoSentinel} className="h-2" aria-hidden="true" />
        {videoErr && visibleVideos.length > 0 && <div role="status" className="flex flex-wrap items-center justify-center gap-2 py-2 text-[12px] text-mut"><span>{tr("短剧加载失败：{0}", videoErr)}</span><Button onClick={() => void (metricSort === "default" ? load("video", videoPage + 1) : loadMetricVideos(metricSort))} className="px-3 text-primary">{tr("重试")}</Button></div>}
        {videoLoading && visibleVideos.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {metricSort === "default" && !videoLoading && !videoErr && videoPage < videoPages && videoAutoLoadPaused && <Button onClick={() => { setVideoEmptyStreak(0); void load("video", videoPage + 1); }} className="my-2 px-4 text-primary">{tr("加载更多短剧")}</Button>}

        {postLoading && !visiblePosts.length && <div className="flex justify-center py-8"><Loader className="w-7 h-7 spinner" /></div>}
        {postErr && !visiblePosts.length && <Empty icon={<TagIcon size={26} />} title={tr("吃瓜帖子加载失败")} sub={postErr} action={tr("重试")} onAction={() => void load("post", 1, true)} />}
        {visiblePosts.length > 0 && <section className="mb-6">
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="text-[15px] font-bold text-on">{tr("吃瓜")}</h2>
            <span className="text-[12px] text-mut tabular-nums">{postTotal}</span>
          </div>
          <FilteredContent items={visiblePosts} scopeKey={`tag-post:${tag}`}>{shownPosts => <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
            {shownPosts.map(post => <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={post.tags?.slice(0, 2).join(" · ")} onOpen={() => push({ kind: "post", id: post.id })} />)}
          </div>}</FilteredContent>
        </section>}
        <div ref={postSentinel} className="h-2" aria-hidden="true" />
        {postErr && visiblePosts.length > 0 && <div role="status" className="flex flex-wrap items-center justify-center gap-2 py-2 text-[12px] text-mut"><span>{tr("吃瓜加载失败：{0}", postErr)}</span><Button onClick={() => void load("post", postPage + 1)} className="px-3 text-primary">{tr("重试")}</Button></div>}
        {postLoading && visiblePosts.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!postLoading && !postErr && postPage < postPages && postAutoLoadPaused && <Button onClick={() => { setPostEmptyStreak(0); void load("post", postPage + 1); }} className="my-2 px-4 text-primary">{tr("加载更多吃瓜")}</Button>}
        {!videoLoading && !postLoading && !videoErr && !postErr && !visibleVideos.length && !visiblePosts.length && <Empty icon={<TagIcon size={26} />} title={tr("该标签下暂无内容")} />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索") })} />}
    </div>
  );
}

import { Button } from "../../shared/ui/ios/controls";
import { Loader } from "../../shared/ui/ios/effects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt } from "../../shared/api/api";
import type { Post, VideoCard } from "../../shared/api/types";
import { useStore } from "../../shared/model/store";
import { MediaCard, Masonry, RowCard } from "../../shared/ui/cards";
import { FilteredContent } from "../../shared/ui/FilteredContent";
import { useContentPreferences } from "../../shared/model/contentPreferences";
import { AUTO_LOAD_EMPTY_PAGE_LIMIT, useAutoLoadMore } from "../../shared/lib/useAutoLoadMore";
import { CollectionLink, CollectionLinks } from "../../shared/ui/CollectionLink";
import { InplaceSearch } from "../search/InplaceSearch";
import { Empty } from "../../shared/ui/ui";
import { IAward, IBack, IChevR, IClock, IFilm, IFlame, ILayers, ISearch, ISpark, IStar, ITag } from "../../shared/ui/icons";
import { tr, N_ } from "../../shared/i18n";
import { useTabSwipe } from "../../shared/ui/hooks/useTabSwipe";
import { VideoSortMenu } from "../../shared/ui/VideoSortMenu";
import { sortVideosByMetric, type VideoSortDirection, type VideoSortMetric } from "../../shared/model/videoSort";

export const CHANNELS = [
  { cate: "ai-duanju", name: N_("AI成人短剧"), Icon: IFilm },
  { cate: "ai-manju", name: N_("AI成人漫剧"), Icon: ISpark },
  { cate: "original", name: N_("原创"), Icon: IAward },
] as const;

/* ================= 分类总览 ================= */
export default function Category({ wide, active }: { wide: boolean; active: boolean }) {
  const { push, lineEpoch } = useStore();
  const [rows, setRows] = useState<Record<string, VideoCard[]>>({});
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(false);
  const started = useRef(false);
  const pending = useRef(new Set<string>());
  const errorsRef = useRef(errors);
  errorsRef.current = errors;
  const lineEpochRef = useRef(lineEpoch);
  lineEpochRef.current = lineEpoch;
  const retryKeys = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const loadPreview = useCallback(async (key: string): Promise<void> => {
    if (pending.current.has(key)) return;
    const requestEpoch = lineEpochRef.current;
    pending.current.add(key);
    setLoading(m => ({ ...m, [key]: true }));
    setErrors(m => ({ ...m, [key]: "" }));
    try {
      if (key === "posts") {
        const result = await api.postCategory("remen-chigua", 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setPosts(result?.items || []);
      } else {
        const result = key === "original"
          ? await api.originalVideos("all", 1, 8, "new")
          : await api.category(key, 1, 8, "latest");
        if (requestEpoch !== lineEpochRef.current) { retryKeys.current.add(key); return; }
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || tr("加载失败") }));
      /* 请求在旧线路上发出、期间线路已切换：等 finally 里用新线路补拉一次 */
      if (stale) retryKeys.current.add(key);
    } finally {
      pending.current.delete(key);
      if (mounted.current) setLoading(m => ({ ...m, [key]: false }));
      const retry = retryKeys.current.delete(key);
      if (retry && mounted.current) void loadPreview(key);
    }
  }, []);

  useEffect(() => {
    // 首次打开分类才加载，避免启动时后台频道请求/封面与首页视频竞争网络。
    if (!active || started.current) return;
    started.current = true;
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [active, loadPreview]);

  /* 线路切换后：已打开过的分类在新线路上重新获取，避免残留旧线路数据 */
  const prevEpoch = useRef(lineEpoch);
  useEffect(() => {
    if (prevEpoch.current === lineEpoch) return;
    prevEpoch.current = lineEpoch;
    if (!started.current) return;
    setRows({});
    setPosts([]);
    setErrors({});
    CHANNELS.forEach(c => { void loadPreview(c.cate); });
    void loadPreview("posts");
  }, [lineEpoch, loadPreview]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0">
        <div className="flex items-baseline gap-2.5">
          <h1 className="ios-page-title text-on">{tr("分类")}</h1>
          {/* 3 个视频频道 + 吃瓜 */}
          <span className="text-[13px] font-medium text-mut">{tr("{0} 个频道", CHANNELS.length + 1)}</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 最近上新 + 热门推荐 + 专题 + 标签（双端统一 2×2 快捷入口） */}
        <CollectionLinks className="ios-category-links mb-6">
          <CollectionLink icon={<IClock size={18} />} title={tr("最近上新")}
            onClick={() => push({ kind: "channel", cate: "newest", name: tr("最近上新") })} />
          <CollectionLink icon={<IStar size={18} />} title={tr("热门推荐")}
            onClick={() => push({ kind: "channel", cate: "recommend", name: tr("热门推荐") })} />
          <CollectionLink icon={<ILayers size={18} />} title={tr("专题")}
            onClick={() => push({ kind: "topics" })} />
          <CollectionLink icon={<ITag size={18} />} title={tr("标签")}
            onClick={() => push({ kind: "tags" })} />
        </CollectionLinks>

        {CHANNELS.map((c, ci) => {
          const list = rows[c.cate] || [];
          const ChannelIcon = c.Icon;
          return (
            <section key={c.cate} aria-label={tr(c.name)} className="mb-6 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <Button onClick={() => push({ kind: "channel", cate: c.cate, name: tr(c.name) })}
                className="w-full flex items-center gap-3 mb-3 text-left pressable group">
                <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
                  <ChannelIcon size={18} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">{tr(c.name)}</span>
                </span>
                <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
                  <span>{tr("全部")}</span><IChevR size={14} />
                </span>
              </Button>
              <FilteredContent items={list} scopeKey={c.cate}>{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label={tr("{0}影片预览", tr(c.name))}>
                {visible.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: tr(c.name) })} />
                ))}
                {!list.length && <PreviewStatus name={tr(c.name)} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>}</FilteredContent>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section aria-label={tr("吃瓜")} className="mb-5 a-rise">
          <Button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-3 mb-3 text-left pressable group">
            <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0">
              <IFlame size={18} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span role="heading" aria-level={2} className="block text-[16px] font-bold text-on leading-tight">{tr("吃瓜")}</span>
            </span>
            <span className="inline-flex items-center gap-0.5 text-[13px] font-medium leading-none text-mut group-hover:text-primary transition-colors shrink-0">
              <span>{tr("全部")}</span><IChevR size={14} />
            </span>
          </Button>
          <FilteredContent items={posts} scopeKey="posts">{visible => <div className="scroll-x flex gap-3 snap-x" role="group" aria-label={tr("吃瓜内容预览")}>
            {visible.map((post) => (
              <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                subtitle={tr("{0} 次浏览", fmt(post.hot))} onOpen={() => push({ kind: "post", id: post.id })} /></div>
            ))}
            {!posts.length && <PreviewStatus name={tr("吃瓜")} loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>}</FilteredContent>
        </section>

        <div className="text-center text-[12px] text-dim pt-1">{tr("— 已展示全部频道 —")}</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div role="status" aria-busy={loading} className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? tr("加载中…") : error || tr("暂无内容")}</span>
    {!loading && error && <Button aria-label={tr("重试{0}", name)} onClick={onRetry} className="text-primary pressable">{tr("重试")}</Button>}
  </div>;
}

/* ================= 频道详情页 ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: N_("最近更新") },
  { value: "hot_window", label: N_("当前热播") },
  { value: "random", label: N_("精选推荐") },
] as const;

const ORIGINAL_CATES = [
  { value: "all", label: N_("全部原创") },
  { value: "ai-manju", label: N_("原创漫剧") },
  { value: "ai-duanju", label: N_("原创短剧") },
] as const;

const originalSort = (cate: (typeof ORIGINAL_CATES)[number]["value"]) =>
  cate === "all" ? "new" : "latest";

const METRIC_PAGE_SIZE = 100;
const METRIC_MAX_PAGES = 30;

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push, lineEpoch } = useStore();
  const { preferences, blockReason } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const blockReasonRef = useRef(blockReason);
  blockReasonRef.current = blockReason;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [metricSort, setMetricSort] = useState<VideoSortMetric>("default");
  const [metricDirection, setMetricDirection] = useState<VideoSortDirection>("desc");
  const [metricVisible, setMetricVisible] = useState(20);
  const metricLoaded = useRef(false);
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const sortedItems = useMemo(() => sortVideosByMetric(items, metricSort, metricDirection), [items, metricSort, metricDirection]);
  const visibleItems = metricSort === "default" ? sortedItems : sortedItems.slice(0, metricVisible);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [emptyStreak, setEmptyStreak] = useState(0);
  const isSingleList = cate === "newest" || cate === "recommend";
  const filterKey = (sort: string, original: string, metric: VideoSortMetric = "default") =>
    `${cate}:${isSingleList ? "default" : cate === "original" ? original : sort}:${metric}`;
  const [displayedFilter, setDisplayedFilter] = useState(() => filterKey("latest", "all"));
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const fetchChannelPage = (targetPage: number, size: number, sortValue: string,
    originalCateValue: typeof originalCate, jsonOnly = false) => cate === "original"
    ? api.originalVideos(originalCateValue, targetPage, size, originalSort(originalCateValue), jsonOnly)
    : api.category(cate, targetPage, size, isSingleList ? undefined : sortValue, jsonOnly);

  /**
   * Metric sorting has to see every page, otherwise appending page 2 would
   * reorder the cards the user is already looking at. Fetch the JSON list in
   * large pages (it carries like/collect/play counts) and sort once at the end.
   */
  const loadMetricPages = async (metric: VideoSortMetric, sortOverride: string = serverSort, originalCateOverride: typeof originalCate = originalCate) => {
    if (metric === "default") return;
    const seq = ++requestSeq.current;
    busy.current = true;
    setLoading(true);
    setRefreshing(true);
    setErr(null);
    setMetricVisible(20);
    let all: VideoCard[] = [];
    let totalPages = 1;
    let requestedPages = 1;
    try {
      const first = await fetchChannelPage(1, METRIC_PAGE_SIZE, sortOverride, originalCateOverride, true);
      if (seq !== requestSeq.current) return;
      totalPages = Math.max(1, first?.pagination?.pages || 1);
      requestedPages = Math.min(totalPages, METRIC_MAX_PAGES);
      all = first?.items || [];
      for (let start = 2; start <= requestedPages; start += 4) {
        const batch: Promise<Awaited<ReturnType<typeof fetchChannelPage>>>[] = [];
        for (let p = start; p < Math.min(start + 4, requestedPages + 1); p += 1) {
          batch.push(fetchChannelPage(p, METRIC_PAGE_SIZE, sortOverride, originalCateOverride, true));
        }
        const results = await Promise.all(batch);
        if (seq !== requestSeq.current) return;
        for (const result of results) all.push(...(result?.items || []));
      }
      if (seq !== requestSeq.current) return;
      const seen = new Set<number>();
      const unique = all.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
      setPageItems([unique]);
      setPage(requestedPages);
      setPages(totalPages);
      setDisplayedFilter(filterKey(sortOverride, originalCateOverride, metric));
      metricLoaded.current = true;
      setEmptyStreak(0);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      if (all.length) {
        const seen = new Set<number>();
        setPageItems([all.filter((item) => !seen.has(item.id) && !!seen.add(item.id))]);
        setPage(requestedPages);
        setPages(totalPages);
        setDisplayedFilter(filterKey(sortOverride, originalCateOverride, metric));
      }
      setErr((e as Error).message || tr("加载失败"));
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const loadMore = async (reset = false, sortOverride: string = serverSort, originalCateOverride = originalCate) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    setErr(null);
    if (reset) { setRefreshing(true); setEmptyStreak(0); }
    try {
      const next = reset ? 1 : page + 1;
      const res = await fetchChannelPage(next, 20, sortOverride, originalCateOverride);
      if (seq !== requestSeq.current) return;
      const incoming = res?.items || [];
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.flat().map((x) => x.id));
        return [...base, incoming.filter((x) => !seen.has(x.id))];
      });
      if (filteringRef.current && incoming.length > 0) {
        const visibleCount = incoming.filter((x) => !blockReasonRef.current(x.tags)).length;
        setEmptyStreak((prev) => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
      } else {
        setEmptyStreak(0);
      }
      setDisplayedFilter(filterKey(sortOverride, originalCateOverride));
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      if (seq === requestSeq.current) setErr((e as Error).message || tr("加载失败"));
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const changeMetricSort = (value: VideoSortMetric, direction: VideoSortDirection = "desc") => {
    if (value === metricSort && direction === metricDirection) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setErr(null);
    setMetricVisible(20);
    if (value === "default") {
      metricLoaded.current = false;
      setMetricSort("default");
      setMetricDirection("desc");
      void loadMore(true, serverSort, originalCate);
      return;
    }
    const metricChanged = value !== metricSort;
    setMetricSort(value);
    setMetricDirection(direction);
    if (!metricChanged) return;
    if (metricLoaded.current) {
      setDisplayedFilter(filterKey(serverSort, originalCate, value));
      return;
    }
    void loadMetricPages(value);
  };

  const changeServerSort = (value: (typeof CHANNEL_SORTS)[number]["value"]) => {
    if (value === serverSort) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setErr(null);
    if (metricSort !== "default") {
      metricLoaded.current = false;
      void loadMetricPages(metricSort, value, originalCate);
    } else {
      void loadMore(true, value);
    }
  };

  const changeOriginalCate = (value: (typeof ORIGINAL_CATES)[number]["value"]) => {
    if (value === originalCate) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setOriginalCate(value);
    setErr(null);
    if (metricSort !== "default") {
      metricLoaded.current = false;
      void loadMetricPages(metricSort, originalSort(value), value);
    } else {
      void loadMore(true, originalSort(value), value);
    }
  };
  const channelTabIndex = cate === "original"
    ? ORIGINAL_CATES.findIndex(s => s.value === originalCate)
    : CHANNEL_SORTS.findIndex(s => s.value === serverSort);
  const channelTabSwipe = useTabSwipe<HTMLDivElement>({
    rootRef: scrollContainer,
    tabIndex: isSingleList ? 0 : channelTabIndex,
    tabCount: isSingleList ? 1 : cate === "original" ? ORIGINAL_CATES.length : CHANNEL_SORTS.length,
    onTabChange: index => {
      if (isSingleList) return;
      if (cate === "original") {
        const next = ORIGINAL_CATES[index];
        if (next) changeOriginalCate(next.value);
      } else {
        const next = CHANNEL_SORTS[index];
        if (next) changeServerSort(next.value);
      }
    },
  });

  useEffect(() => {
    setPageItems([]); setPage(0); setPages(1);
    setServerSort("latest"); setOriginalCate("all"); setSearching(false);
    setMetricSort("default"); setMetricDirection("desc"); setMetricVisible(20); metricLoaded.current = false;
    void loadMore(true, "latest", "all");
    return () => { requestSeq.current++; busy.current = false; };
    /* eslint-disable-next-line */
  }, [cate, lineEpoch]);
  const filterPending = displayedFilter !== filterKey(serverSort, originalCate, metricSort);
  const replacing = refreshing || filterPending;
  useEffect(() => { setEmptyStreak(0); }, [filtering, preferences.blockedTags, preferences.hideUntagged]);
  const autoLoadPaused = filtering && emptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT;
  useAutoLoadMore({
    scrollRef: scrollContainer,
    sentinelRef: sentinel,
    enabled: !loading && !err && !replacing
      && (metricSort === "default" ? page < pages && !autoLoadPaused : metricVisible < sortedItems.length),
    watchKey: `${page}:${pages}:${items.length}:${metricSort}:${metricDirection}:${metricVisible}`,
    onLoadMore: () => {
      if (metricSort !== "default") {
        setMetricVisible(count => Math.min(count + 20, sortedItems.length));
      } else {
        void loadMore();
      }
    },
    rootMargin: "300px",
  });

  const ChannelGlyph = cate === "newest"
    ? IClock
    : cate === "recommend"
      ? IStar
      : CHANNELS.find(c => c.cate === cate)?.Icon ?? IFilm;
  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-subpage-header shrink-0" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="ios-subpage-bar">
          <Button aria-label={tr("返回")} onClick={onBack} className="ios-nav-btn"><IBack size={20} /></Button>
          <span className="w-9 h-9 rounded-[12px] bg-pc text-on-pc flex items-center justify-center shrink-0"><ChannelGlyph size={18} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <h1 className="text-[17px] font-bold text-on leading-tight truncate">{name}</h1>
            <div role="status" className="text-[12px] text-mut leading-tight mt-0.5">{replacing ? (isSingleList ? (loading ? tr("加载中…") : tr("加载失败")) : (loading && metricSort !== "default" ? tr("正在加载全部结果以排序…") : (loading ? tr("正在更新筛选结果…") : tr("筛选更新失败")))) : tr("已加载 {0} 部 · {1}/{2} 页", sortedItems.length, page, Math.max(pages, 1))}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={cate === "original" ? tr("搜索原创") : tr("搜索短剧")} className="ios-nav-btn"><ISearch size={18} /></Button>
        </div>
        {cate === "original" && (
          <div className="ios-subpage-inner ios-channel-tabs pb-3 flex flex-wrap items-center gap-1.5">
            {ORIGINAL_CATES.map((s) => (
              <Button aria-pressed={originalCate === s.value} key={s.value} onClick={() => changeOriginalCate(s.value)}
                className="ios-filter-pill">{tr(s.label)}</Button>
            ))}
            <VideoSortMenu className="ml-auto" value={metricSort} direction={metricDirection} onChange={changeMetricSort} />
          </div>
        )}
        {!isSingleList && cate !== "original" && (
          <div className="ios-subpage-inner ios-channel-tabs pb-3 flex flex-wrap items-center gap-1.5">
            {CHANNEL_SORTS.map((s) => (
              <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
                className="ios-filter-pill">{tr(s.label)}</Button>
            ))}
            <VideoSortMenu className="ml-auto" value={metricSort} direction={metricDirection} onChange={changeMetricSort} />
          </div>
        )}
      </div>
      <div ref={scrollContainer} {...channelTabSwipe} style={{ touchAction: "pan-y" }}
        className="flex-1 scroll-y pt-3.5 pb-8" aria-busy={loading}>
        {sortedItems.length > 0 && replacing && <p role="status" className="mb-3 text-[12px] text-mut">{loading ? tr("正在更新，暂时保留上次结果…") : tr("当前显示上次结果，请重试以更新筛选。")}</p>}
        {sortedItems.length > 0 && err && <div role="status" className="mb-3 flex flex-wrap items-center gap-2 text-[12px] text-mut"><span>{err}</span><Button className="px-3 text-primary" onClick={() => void (metricSort === "default" ? loadMore(replacing) : loadMetricPages(metricSort))}>{tr("重试")}</Button></div>}
        {visibleItems.length ? (
          <div inert={replacing || undefined} className={replacing ? "opacity-60" : undefined}>
            <Masonry videos={visibleItems} scopeKey={`${filterKey(serverSort, originalCate, metricSort)}:${metricDirection}`} wide={wide} onOpen={(v, visible) => { if (!replacing) push({ kind: "feed", videoIds: visible.map((x) => x.id), index: visible.findIndex((x) => x.id === v.id), title: name }); }} />
          </div>
        ) : err ? (
          <Empty icon={<ChannelGlyph size={26} />} title={tr("加载失败")} sub={err} action={tr("重试")} onAction={() => void (metricSort === "default" ? loadMore(true) : loadMetricPages(metricSort))} />
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        ) : <Empty icon={<ChannelGlyph size={26} />} title={isSingleList ? tr("暂无内容") : tr("该筛选下暂无内容")} sub={isSingleList ? undefined : tr("换个筛选试试")} />}
        <div ref={sentinel} className="h-10" aria-hidden="true" />
        {loading && visibleItems.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && !replacing && metricSort === "default" && page < pages && autoLoadPaused && (
          <div className="flex justify-center"><Button onClick={() => { setEmptyStreak(0); void loadMore(); }} className="my-3 px-4 text-primary">{tr("加载更多")}</Button></div>
        )}
        {!loading && !replacing && !err && (metricSort === "default" ? page >= pages : metricVisible >= sortedItems.length) && visibleItems.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">{tr("— 已经到底啦 —")}</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list, kw) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: kw ? tr("搜索 · {0}", kw) : tr("搜索 · {0}", name) })} />}
    </div>
  );
}

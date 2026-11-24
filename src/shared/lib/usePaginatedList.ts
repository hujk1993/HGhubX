import { useCallback, useEffect, useRef, useState } from "react";
import type { Paged } from "../api/types";
import { tr } from "../i18n";
import { AUTO_LOAD_EMPTY_PAGE_LIMIT, useAutoLoadMore } from "./useAutoLoadMore";

type Options<T> = {
  enabled?: boolean;
  /** 内容过滤激活时，连续多页过滤后全空才暂停自动翻页，避免死循环请求 */
  filtering?: boolean;
  /** 可选：判断当前条目是否通过过滤；传入后在连续空页上限内保持自动续载 */
  isVisible?: (item: T) => boolean;
  resetKey?: string | number;
  rootMargin?: string;
  getId: (item: T) => number | string;
  request: (page: number) => Promise<Paged<T> | null | undefined>;
};

/** 统一列表分页、跨账号/线路代次丢弃、去重与滚动哨兵自动加载。 */
export function usePaginatedList<T>({
  enabled = true,
  filtering = false,
  isVisible,
  resetKey = "",
  rootMargin = "240px",
  getId,
  request,
}: Options<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [emptyStreak, setEmptyStreak] = useState(0);
  const generation = useRef(0);
  const cursor = useRef({ page: 0, pages: 1, busy: false });
  const requestRef = useRef(request);
  requestRef.current = request;
  const getIdRef = useRef(getId);
  getIdRef.current = getId;
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const filteringRef = useRef(filtering);
  filteringRef.current = filtering;
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async (reset = false) => {
    const state = cursor.current;
    if (!enabled) return;
    if (!reset && (state.busy || state.page >= state.pages)) return;
    const version = reset ? ++generation.current : generation.current;
    const next = reset ? 1 : state.page + 1;
    state.busy = true;
    setLoading(true);
    setErr("");
    if (reset) setEmptyStreak(0);
    try {
      const response = await requestRef.current(next);
      if (version !== generation.current) return;
      const incoming = response?.items || [];
      const idOf = getIdRef.current;
      setItems((previous) => {
        const base = reset ? [] : previous;
        const seen = new Set(base.map(idOf));
        const unique = incoming.filter((item) => {
          const key = idOf(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return [...base, ...unique];
      });
      if (filteringRef.current && isVisibleRef.current && incoming.length > 0) {
        const visibleCount = incoming.filter((item) => isVisibleRef.current!(item)).length;
        setEmptyStreak((prev) => (visibleCount > 0 ? 0 : (reset ? 1 : prev + 1)));
      } else {
        setEmptyStreak(0);
      }
      const resolvedPages = response?.pagination?.pages || next;
      state.page = next;
      state.pages = incoming.length > 0 || next === 1 ? resolvedPages : next;
      setPage(next);
      setPages(state.pages);
      setTotal(Number.isFinite(response?.pagination?.total) ? response!.pagination.total : null);
      setHasMore(next < state.pages && incoming.length > 0);
    } catch (error) {
      if (version === generation.current) {
        setErr(error instanceof Error ? error.message : tr("加载失败，请重试"));
      }
    } finally {
      if (version === generation.current) {
        state.busy = false;
        setLoading(false);
      }
    }
  }, [enabled]);

  useEffect(() => {
    generation.current++;
    cursor.current = { page: 0, pages: 1, busy: false };
    setItems([]);
    setPage(0);
    setPages(1);
    setErr("");
    setTotal(null);
    setHasMore(false);
    setEmptyStreak(0);
    setLoading(false);
    if (scroller.current) scroller.current.scrollTop = 0;
    if (enabled) void loadMore(true);
    return () => {
      generation.current++;
      cursor.current.busy = false;
    };
  }, [enabled, resetKey, loadMore]);

  useEffect(() => {
    setEmptyStreak(0);
  }, [filtering]);

  const autoLoadPaused = filtering && (!isVisible || emptyStreak >= AUTO_LOAD_EMPTY_PAGE_LIMIT);

  const manualLoadMore = useCallback((reset = false) => {
    setEmptyStreak(0);
    return loadMore(reset);
  }, [loadMore]);

  useAutoLoadMore({
    scrollRef: scroller,
    sentinelRef: sentinel,
    enabled: enabled && !autoLoadPaused && !loading && !err && hasMore,
    watchKey: `${page}:${pages}:${items.length}`,
    onLoadMore: () => { void loadMore(); },
    rootMargin,
  });

  return { items, page, pages, loading, err, total, hasMore, autoLoadPaused, loadMore: manualLoadMore, scroller, sentinel };
}

import { useEffect, useRef, type RefObject } from "react";

/** 连续出现该数量个过滤后全空分页时，暂停自动续载并显示手动兜底按钮，防止死循环请求。 */
export const AUTO_LOAD_EMPTY_PAGE_LIMIT = 2;

type Options = {
  scrollRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  /** 页码等变化键：即使请求在同一渲染批次内快速完成，也能重新武装哨兵 */
  watchKey?: string | number;
  onLoadMore: () => void;
  rootMargin?: string;
  thresholdPx?: number;
};

/** 结合 IntersectionObserver 与滚动容器位置检查，在哨兵接近视口底部时自动触发下一页加载。 */
export function useAutoLoadMore({
  scrollRef,
  sentinelRef,
  enabled,
  watchKey,
  onLoadMore,
  rootMargin = "300px",
  thresholdPx = 360,
}: Options) {
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const scroller = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!enabled || !scroller || !sentinel) return;

    let triggered = false;
    const fire = () => {
      if (triggered) return;
      triggered = true;
      onLoadMoreRef.current();
    };

    const nearSentinel = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      if (scrollerRect.height <= 0) return false;
      const sentinelRect = sentinel.getBoundingClientRect();
      return sentinelRect.top <= scrollerRect.bottom + thresholdPx;
    };

    const onScroll = () => {
      if (nearSentinel()) fire();
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) fire();
        },
        { root: scroller, rootMargin },
      );
      io.observe(sentinel);
    }

    scroller.addEventListener("scroll", onScroll, { passive: true });
    const raf = window.requestAnimationFrame(() => {
      if (nearSentinel()) fire();
    });

    return () => {
      window.cancelAnimationFrame(raf);
      scroller.removeEventListener("scroll", onScroll);
      io?.disconnect();
    };
  }, [enabled, watchKey, rootMargin, thresholdPx, scrollRef, sentinelRef]);
}

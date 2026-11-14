import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RowCard } from "../components/cards";
import { CollectionLink, CollectionLinks } from "../components/CollectionLink";
import { InplaceSearch } from "../components/InplaceSearch";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IGlobe, IGrid, ISearch, ITrophy } from "../icons";

export const CHANNELS = [
  { cate: "ai-duanju", name: "AI成人短剧", desc: "高能反转 · 一口气看完" },
  { cate: "ai-manju", name: "AI成人漫剧", desc: "国创漫剧 · 每周更新" },
  { cate: "original", name: "原创", desc: "原创 · 独家好剧" },
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
        if (mounted.current) setPosts(result?.items || []);
      } else {
        const result = key === "original"
          ? await api.originalVideos("all", 1, 8, "new")
          : await api.category(key, 1, 8, "latest");
        if (mounted.current) setRows(m => ({ ...m, [key]: result?.items || [] }));
      }
    } catch (error) {
      const stale = requestEpoch !== lineEpochRef.current;
      if (mounted.current && !stale) setErrors(m => ({ ...m, [key]: (error as Error).message || "加载失败" }));
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

  /* 线路切换后：已打开过的分类里，加载失败的栏目在新线路上重试一次 */
  useEffect(() => {
    if (!lineEpoch || !started.current) return;
    Object.entries(errorsRef.current).forEach(([key, msg]) => { if (msg) void loadPreview(key); });
  }, [lineEpoch, loadPreview]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0 px-4">
        <div className="flex items-end gap-2.5">
          <span className="ios-page-title text-on">分类</span>
          <span className="text-[12px] text-mut pb-0.5">{CHANNELS.length + 1} 个频道 · 每周持续上新</span>
        </div>
      </div>

      <div className="flex-1 scroll-y pb-24 pt-2">
        {/* 排行榜入口：只在移动端显示（底部导航没有排行榜，桌面侧栏已有） */}
        {!wide && (
          <CollectionLink icon={<ITrophy size={18} />} title="排行榜" subtitle="热播榜 · 推荐榜 · 潜力榜"
            onClick={() => push({ kind: "ranks" })} className="mx-4 mb-2.5 w-[calc(100%-2rem)]" />
        )}

        {/* 专题 + 标签入口 */}
        <CollectionLinks className="ios-category-links mx-4 mb-5">
          <CollectionLink icon={<IGrid size={18} />} title="专题" subtitle="精选专辑合集"
            onClick={() => push({ kind: "topics" })} />
          <CollectionLink icon={<IGlobe size={18} />} title="标签" subtitle="按题材找片"
            onClick={() => push({ kind: "tags" })} />
        </CollectionLinks>

        {CHANNELS.map((c, ci) => {
          const list = rows[c.cate] || [];
          return (
            <section key={c.cate} aria-label={c.name} className="mb-5 a-rise" style={{ animationDelay: `${Math.min(ci * 50, 300)}ms` }}>
              <Button onClick={() => push({ kind: "channel", cate: c.cate, name: c.name })}
                className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
                <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
                  <IGrid size={19} strokeWidth={1.9} />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[15.5px] font-semibold text-on leading-tight">{c.name}</span>
                  <span className="block text-[12px] text-mut mt-0.5 truncate">{c.desc}</span>
                </span>
                <span className="flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
                  全部<IChevR size={14} />
                </span>
              </Button>
              <div className="scroll-x flex gap-2.5 px-4 snap-x">
                {list.map((v) => (
                  <RowCard key={v.id} v={v} onOpen={() => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: c.name })} />
                ))}
                {!list.length && <PreviewStatus name={c.name} loading={loading[c.cate] !== false} error={errors[c.cate]} onRetry={() => void loadPreview(c.cate)} />}
              </div>
            </section>
          );
        })}

        {/* 吃瓜 */}
        <section aria-label="吃瓜" className="mb-5 a-rise">
          <Button onClick={() => push({ kind: "posts" })}
            className="w-full flex items-center gap-2.5 px-4 mb-2.5 text-left pressable group">
            <span className="w-[36px] h-[36px] rounded-(--r-sm) tonal flex items-center justify-center shrink-0 text-primary">
              <IGrid size={19} strokeWidth={1.9} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15.5px] font-semibold text-on leading-tight">吃瓜</span>
              <span className="block text-[12px] text-mut mt-0.5 truncate">圈内爆料 · 每日更新</span>
            </span>
            <span className="flex items-center gap-0.5 text-[12px] text-mut group-hover:text-primary transition-colors">
              全部<IChevR size={14} />
            </span>
          </Button>
          <div className="scroll-x flex gap-2.5 px-4 snap-x">
            {posts.map((post) => (
              <div key={post.id} className="ios-row-card"><MediaCard title={post.title} cover={post.cover}
                subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} /></div>
            ))}
            {!posts.length && <PreviewStatus name="吃瓜" loading={loading.posts !== false} error={errors.posts} onRetry={() => void loadPreview("posts")} />}
          </div>
        </section>

        <div className="px-4 text-center text-[12px] text-dim pt-1">— 已展示全部频道 —</div>
      </div>
      {wide && <div />}
    </div>
  );
}

function PreviewStatus({ name, loading, error, onRetry }: { name: string; loading: boolean; error?: string; onRetry: () => void }) {
  return <div className="h-[150px] flex flex-col justify-center items-start gap-2 text-[12px] text-dim px-1">
    <span>{loading ? "加载中…" : error || "暂无内容"}</span>
    {!loading && error && <Button aria-label={`重试${name}`} onClick={onRetry} className="text-primary pressable">重试</Button>}
  </div>;
}

/* ================= 频道详情页 ================= */
const CHANNEL_SORTS = [
  { value: "latest", label: "最近更新" },
  { value: "hot_window", label: "当前热播" },
  { value: "random", label: "精选推荐" },
] as const;

const ORIGINAL_CATES = [
  { value: "all", label: "全部原创" },
  { value: "ai-manju", label: "原创漫剧" },
  { value: "ai-duanju", label: "原创短剧" },
] as const;

const originalSort = (cate: (typeof ORIGINAL_CATES)[number]["value"]) =>
  cate === "all" ? "new" : "latest";

export function ChannelPage({ cate, name, onBack, wide }: { cate: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [serverSort, setServerSort] = useState<(typeof CHANNEL_SORTS)[number]["value"]>("latest");
  const [originalCate, setOriginalCate] = useState<(typeof ORIGINAL_CATES)[number]["value"]>("all");
  const [pageItems, setPageItems] = useState<VideoCard[][]>([]);
  const items = pageItems.flat();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const requestSeq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);

  const loadMore = async (reset = false, sortOverride: string = serverSort, originalCateOverride = originalCate) => {
    const seq = reset ? ++requestSeq.current : requestSeq.current;
    if (!reset && (busy.current || page >= pages)) return;
    busy.current = true;
    setLoading(true);
    try {
      const next = reset ? 1 : page + 1;
      const res = cate === "original"
        ? await api.originalVideos(originalCateOverride, next, 20, originalSort(originalCateOverride))
        : await api.category(cate, next, 20, sortOverride);
      if (seq !== requestSeq.current) return;
      setPageItems((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.flat().map((x) => x.id));
        return [...base, (res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(next);
      setPages(res?.pagination?.pages || next);
      setErr(null);
    } catch (e) {
      if (seq === requestSeq.current) setErr((e as Error).message || "加载失败");
    } finally {
      if (seq === requestSeq.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const changeServerSort = (value: (typeof CHANNEL_SORTS)[number]["value"]) => {
    if (value === serverSort) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setServerSort(value);
    setPageItems([]);
    setPage(0);
    setPages(1);
    setErr(null);
    void loadMore(true, value);
  };

  const changeOriginalCate = (value: (typeof ORIGINAL_CATES)[number]["value"]) => {
    if (value === originalCate) return;
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    setOriginalCate(value);
    setPageItems([]);
    setPage(0);
    setPages(1);
    setErr(null);
    void loadMore(true, originalSort(value), value);
  };

  useEffect(() => { void loadMore(true); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) void loadMore(); }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="px-3 pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <span className="w-[40px] h-[40px] rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><IGrid size={21} strokeWidth={1.9} /></span>
          <div className="flex-1 min-w-0">
            <div className="text-[17px] font-bold text-on leading-tight">{name}</div>
            <div className="text-[12px] text-mut">共 {items.length} 部 · 已加载 {page}/{Math.max(pages, 1)} 页</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label={cate === "original" ? "搜索原创" : "搜索短剧"} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
        {cate === "original" && (
          <div className="px-4 pb-2 flex flex-wrap gap-2">
            {ORIGINAL_CATES.map((s) => (
              <Button aria-pressed={originalCate === s.value} key={s.value} onClick={() => changeOriginalCate(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
        {cate !== "original" && (
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            {CHANNEL_SORTS.map((s) => (
              <Button aria-pressed={serverSort === s.value} key={s.value} onClick={() => changeServerSort(s.value)}
                className="ios-filter-pill">{s.label}</Button>
            ))}
          </div>
        )}
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y px-4 pt-3 pb-8">
        {items.length ? (
          <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: name })} />
        ) : err ? (
          <Empty icon={<IGrid size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void loadMore(true)} />
        ) : (
          <div className="flex justify-center py-10"><Loader className="w-8 h-8 spinner" /></div>
        )}
        <div ref={sentinel} className="h-10" />
        {loading && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && page >= pages && items.length > 0 && (
          <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>
        )}
      </div>
      {searching && <InplaceSearch kind="video" scope={cate === "original" ? "original" : undefined} wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: `搜索 · ${name}` })} />}
    </div>
  );
}

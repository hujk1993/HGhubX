import { Button, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, fmt } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { MAX_BLOCKED_TAGS, MAX_TAG_LENGTH, useContentPreferences } from "../contentPreferences";
import { Masonry } from "../components/cards";
import { InplaceSearch } from "../components/InplaceSearch";
import { Empty, Img } from "../components/ui";
import { IBack, IGrid, IGlobe, IRefresh, ISearch } from "../icons";

const TopicIcon = IGrid;
const TagIcon = IGlobe;

/** Retain the last good result on refresh, but never expose a previous route's data. */
function useDiscoveryData<T>(key: string, request: () => Promise<T>) {
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
      if (token === sequence.current) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : "加载失败，请重试" }));
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
    {loading ? <><Loader className="w-4 h-4" />正在刷新，保留当前内容…</>
      : <><span className="min-w-0 break-words">刷新失败，保留当前内容。{error}</span><Button onClick={onRetry} className="px-3 text-primary">重试</Button></>}
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
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <h1 className="text-[17px] font-bold text-on">专题</h1>
          <span className="text-[12px] text-mut">{items.length} 个专辑</span>
          <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
          <Button aria-label="刷新" disabled={loading} aria-busy={loading} onClick={() => void load()} className="w-9 h-9 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={16} />}</Button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8" aria-busy={loading}>
        {items.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
        {loading && !items.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !items.length ? (
          <Empty icon={<TopicIcon size={26} />} title="专题加载失败" sub={err} action="重试" onAction={load} />
        ) : items.length ? (
          <div className={`grid gap-3 ${wide ? "grid-cols-3 xl:grid-cols-4" : "grid-cols-2"}`}>
            {items.map((t) => (
              <Button key={t.id} onClick={() => push({ kind: "topic", slug: t.slug, name: t.title })}
                title={t.title} className="ios-topic-card min-w-0 text-left overflow-hidden bg-s1 elev-1 pressable a-rise">
                <div className="relative w-full" style={{ paddingTop: "56%" }}>
                  <Img src={t.cover} />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full bg-black/55 backdrop-blur-sm text-[12px] font-semibold text-white/90">
                    {t.video_count ?? 0} 部
                  </span>
                </div>
                <div className="p-2.5">
                  <div className="text-[14px] font-semibold text-on clamp-1 leading-tight">{t.title}</div>
                  {t.intro && <div className="text-[12px] text-mut clamp-2 mt-1 leading-relaxed">{t.intro}</div>}
                </div>
              </Button>
            ))}
          </div>
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无专题" />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: "搜索 · 专题" })} />}
    </div>
  );
}

/* ================= 专题详情页 ================= */
export function TopicPage({ slug, name, onBack, wide }: { slug: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const [introExpanded, setIntroExpanded] = useState(false);
  const introId = useId();
  // The topic endpoint returns the complete list; it has no page parameter.
  const { data, loading, err, load } = useDiscoveryData(slug, () => api.topic(slug));
  const topic = data?.topic;
  const related = data?.related ?? [];
  const videos = data?.videos?.items ?? [];
  useEffect(() => { setIntroExpanded(false); setSearching(false); }, [slug]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-bold text-on truncate" title={topic?.title || name}>{topic?.title || name}</h1>
            <div className="text-[12px] text-mut">{loading ? "加载中…" : `已展示 ${videos.length} 部`}</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>

      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8" aria-busy={loading}>
        {topic?.intro && <section className="mb-4" aria-label="专题简介">
          <p id={introId} className={`text-[13px] text-mut leading-relaxed break-words ${introExpanded ? "" : "clamp-3"}`}>{topic.intro}</p>
          <Button aria-expanded={introExpanded} aria-controls={introId} onClick={() => setIntroExpanded(value => !value)} className="mt-1 px-2 text-[12px] text-primary">{introExpanded ? "收起简介" : "展开简介"}</Button>
        </section>}
        {related.length > 0 && (
          <div className="mb-4">
            <h2 className="text-[13px] font-semibold text-on/80 mb-2">相关专题</h2>
            <div className="scroll-x flex gap-2.5 snap-x">
              {related.map((r) => (
                <Button key={r.id} onClick={() => push({ kind: "topic", slug: r.slug, name: r.title })}
                  className="ios-topic-card w-[140px] shrink-0 text-left snap-start pressable">
                  <Surface className="ios-topic-art relative w-full overflow-hidden bg-s1 elev-1" style={{ paddingTop: "56%" }}>
                    <Img src={r.cover} />
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/55 text-[12px] font-semibold text-white/90">{r.video_count ?? 0} 部</span>
                  </Surface>
                  <div className="mt-1.5 text-[12px] font-medium text-on clamp-1 leading-tight">{r.title}</div>
                </Button>
              ))}
            </div>
          </div>
        )}

        {loading && !videos.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !videos.length ? (
          <Empty icon={<TopicIcon size={26} />} title="加载失败" sub={err} action="重试" onAction={load} />
        ) : videos.length ? (
          <Masonry videos={videos} scopeKey={slug} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: videos.map((x) => x.id), index: videos.findIndex((x) => x.id === v.id), title: topic?.title || name })} />
        ) : (
          <Empty icon={<TopicIcon size={26} />} title="暂无内容" />
        )}
        {loading && videos.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: topic?.title || name })} />}
    </div>
  );
}

/* ================= 标签聚合页 ================= */
export function TagsPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const [searching, setSearching] = useState(false);
  const { data, loading, err, load } = useDiscoveryData("tags", api.tags);
  const groups = data?.categories ?? [];

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <h1 className="text-[17px] font-bold text-on">标签</h1>
          <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
          <Button aria-label="刷新" disabled={loading} aria-busy={loading} onClick={() => void load()} className="w-9 h-9 rounded-full flex items-center justify-center text-mut hover:bg-s3 pressable">{loading ? <Loader className="w-4 h-4" /> : <IRefresh size={16} />}</Button>
        </div>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8" aria-busy={loading}>
        {groups.length > 0 && <RefreshStatus loading={loading} error={err} onRetry={() => void load()} />}
        {loading && !groups.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !groups.length ? (
          <Empty icon={<TagIcon size={26} />} title="标签加载失败" sub={err} action="重试" onAction={load} />
        ) : groups.length ? (
          <div className={wide ? "grid grid-cols-2 gap-x-6 items-start" : ""}>{groups.map((g) => (
            <section key={g.name} className="mb-5 a-rise">
              <div className="flex items-center gap-2 mb-2.5">
                <h2 className="text-[14px] font-bold text-on">{g.name}</h2>
                <span className="text-[12px] text-dim">{g.tags?.length || 0} 个</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {g.tags.map((t) => (
                  <Button key={t.id} onClick={() => push({ kind: "tag", tag: t.name, name: t.name })}
                    className="ios-filter-pill max-w-full min-w-0 flex items-center gap-2 text-left">
                    <span className="min-w-0 whitespace-normal break-all">{t.name}</span>
                    {!!t.hot_score && <span className="shrink-0 text-[12px] text-dim">{fmt(t.hot_score)}</span>}
                  </Button>
                ))}
              </div>
            </section>
          ))}</div>
        ) : (
          <Empty icon={<TagIcon size={26} />} title="暂无标签" />
        )}
        {wide && <div className="h-2" />}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map((x) => x.id), index: list.findIndex((x) => x.id === v.id), title: "搜索 · 标签" })} />}
    </div>
  );
}

/* ================= 标签视频页 ================= */
export function TagPage({ tag, name, onBack, wide }: { tag: string; name: string; onBack: () => void; wide: boolean }) {
  const { push } = useStore();
  const { preferences, storageError, isTagBlocked, blockTags, unblockTag } = useContentPreferences();
  const filtering = !preferences.paused && (preferences.blockedTags.length > 0 || preferences.hideUntagged);
  const tagBlocked = isTagBlocked(name);
  const cannotAdd = !name.trim() || name.trim().length > MAX_TAG_LENGTH || preferences.blockedTags.length >= MAX_BLOCKED_TAGS;
  const [searching, setSearching] = useState(false);
  const [items, setItems] = useState<VideoCard[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [loadedTag, setLoadedTag] = useState(tag);
  const busy = useRef(false);
  const sequence = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const scrollContainer = useRef<HTMLDivElement>(null);
  const current = loadedTag === tag;
  const visibleItems = current ? items : [];

  const load = useCallback(async (next: number, reset = false) => {
    if (busy.current && !reset) return;
    busy.current = true;
    const token = ++sequence.current;
    setLoading(true); setErr("");
    try {
      const result = await api.tagVideos(tag, next, 20);
      if (sequence.current !== token) return;
      setItems(previous => {
        const base = reset ? [] : previous;
        const seen = new Set(base.map(item => item.id));
        return [...base, ...(result?.items ?? []).filter(item => !seen.has(item.id))];
      });
      setLoadedTag(tag); setPage(next); setPages(result?.pagination?.pages || next);
    } catch (error) {
      if (sequence.current === token) setErr(error instanceof Error ? error.message : "加载失败，请重试");
    } finally {
      if (sequence.current === token) { busy.current = false; setLoading(false); }
    }
  }, [tag]);
  useEffect(() => {
    setItems([]); setLoadedTag(tag); setPage(0); setPages(1); setSearching(false);
    if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
    void load(1, true);
    return () => { sequence.current++; busy.current = false; };
  }, [load, tag]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || filtering || err || loading || page >= pages) return;
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) void load(page + 1);
    }, { root: scrollContainer.current, rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [load, page, pages, err, loading, filtering]);

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="pt-2 pb-3 flex items-center gap-2.5">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[16px] font-bold text-on truncate" title={name}>{name}</h1>
            <div role="status" className="text-[12px] text-mut">已加载 {visibleItems.length} 部</div>
          </div>
          <Button onClick={() => setSearching(true)} aria-label="搜索短剧" className="ml-auto w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><ISearch size={19} /></Button>
        </div>
      </div>
      <div ref={scrollContainer} className="flex-1 scroll-y px-4 pt-3 pb-8" aria-busy={loading || !current}>
        <Surface className="mb-3 rounded-(--r-md) p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-[13px] text-mut">{tagBlocked ? "此标签已加入屏蔽列表" : "不喜欢这类内容？可屏蔽整个标签。"}</p>
            <Button style={{ minBlockSize: 44 }} disabled={!tagBlocked && cannotAdd} aria-pressed={tagBlocked}
              onClick={() => tagBlocked ? unblockTag(name) : blockTags([name])}
              className="min-h-11 rounded-(--r-ctl) bg-s2 px-4 text-[13px] text-primary">{tagBlocked ? "取消屏蔽此标签" : "屏蔽此标签"}</Button>
          </div>
          {preferences.paused && <p role="status" className="mt-2 text-[12px] text-mut">屏蔽已暂停，新增标签会保存，恢复后生效。</p>}
          {!tagBlocked && cannotAdd && <p role="status" className="mt-2 text-[12px] text-mut">{name.trim().length > MAX_TAG_LENGTH ? "标签过长，请在内容偏好中管理。" : `已达到 ${MAX_BLOCKED_TAGS} 个标签上限。`}</p>}
          {storageError && <p role="alert" className="mt-2 text-[13px] text-danger">{storageError}</p>}
          <Button className="mt-1 min-h-11 px-3 text-[12px] text-primary" onClick={() => push({ kind: "settings", section: "内容偏好" })}>管理屏蔽标签</Button>
        </Surface>
        {(loading || !current) && !visibleItems.length ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : err && !visibleItems.length ? (
          <Empty icon={<TagIcon size={26} />} title="加载失败" sub={err} action="重试" onAction={() => void load(1, true)} />
        ) : visibleItems.length ? (
          <Masonry videos={visibleItems} scopeKey={tag} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: visibleItems.map(x => x.id), index: visibleItems.findIndex(x => x.id === v.id), title: name })} />
        ) : <Empty icon={<TagIcon size={26} />} title="该标签下暂无内容" />}
        <div ref={sentinel} className="h-8" />
        {err && visibleItems.length > 0 && <div role="status" className="flex flex-wrap items-center justify-center gap-2 text-[12px] text-mut"><span>加载更多失败：{err}</span><Button onClick={() => void load(page + 1)} className="px-3 text-primary">重试</Button></div>}
        {loading && visibleItems.length > 0 && <div className="flex justify-center py-3"><Loader className="w-6 h-6 spinner" /></div>}
        {!loading && !err && page < pages && <Button onClick={() => void load(page + 1)} className="my-3 px-4 text-primary">加载更多</Button>}
        {!loading && visibleItems.length > 0 && page >= pages && <div className="text-center text-[12px] text-dim py-3">— 已经到底啦 —</div>}
      </div>
      {searching && <InplaceSearch kind="video" wide={wide} onClose={() => setSearching(false)} onOpenVideo={(v, list) => push({ kind: "feed", videoIds: list.map(x => x.id), index: list.findIndex(x => x.id === v.id), title: name })} />}
    </div>
  );
}

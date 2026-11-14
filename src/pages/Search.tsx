import { Button, Form, Input, SegmentedControl, Surface } from "../components/ios/controls";
import { Loader } from "../components/ios/effects";
import { useEffect, useRef, useState } from "react";
import { api, fmt, isMobile } from "../api";
import type { HotSearchVideo, Post, RankItem, VideoCard } from "../types";
import { useStore } from "../store";
import { MediaCard, Masonry, RankRow } from "../components/cards";
import { Empty, Img } from "../components/ui";
import { IBack, IChevR, IClose, IFireF, IPlayF, IRefresh, ISearch, ITrophy } from "../icons";

const HOT_TAGS = ["都市", "逆袭", "古风", "系统", "后宫", "校园", "仙侠", "职场", "大男主", "御姐", "脑洞", "奇幻"];

export default function Search({ active, wide }: { active: boolean; wide: boolean }) {
  const { push, searchHist, addSearch, clearSearchHist, toast } = useStore();
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [tab, setTab] = useState<"video" | "post">("video");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  /* 请求序号：新关键词或清空时自增，过期请求的结果直接丢弃 */
  const seqRef = useRef(0);
  const [hotVideos, setHotVideos] = useState<HotSearchVideo[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotError, setHotError] = useState<string | null>(null);
  const hotBusy = useRef(false);
  const hotLoadedAt = useRef(0);

  /* 移动端进入搜索页不自动聚焦：iOS 会立刻弹键盘遮住内容（#20）。
     桌面端没有软键盘，聚焦便于直接打字。 */
  useEffect(() => {
    if (active && !isMobile) inputRef.current?.focus();
  }, [active]);

  const refreshHot = async () => {
    if (hotBusy.current) return;
    hotBusy.current = true;
    setHotLoading(true);
    setHotError(null);
    try {
      const res = await api.searchHot();
      setHotVideos(res.items);
      hotLoadedAt.current = Date.now();
    } catch (e) {
      setHotError(e instanceof Error ? e.message : "热搜榜加载失败，请重试");
    } finally {
      hotBusy.current = false;
      setHotLoading(false);
    }
  };
  useEffect(() => {
    // 切换主导航时短暂复用榜单；手动刷新始终重新获取官网内容。
    if (active && Date.now() - hotLoadedAt.current > 60_000) void refreshHot();
  }, [active]);

  const run = async (keyword: string, p: number, kind: "video" | "post" = tab) => {
    if (p > 1 && (busy.current || p > pages)) return;
    const seq = p === 1 ? ++seqRef.current : seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = await api.search(keyword, p, 20, kind);
      if (seq !== seqRef.current) return;
      if (kind === "post") {
        const list = (res?.items || []) as unknown as Post[];
        setPosts((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
        });
      } else {
        const list = (res?.items || []) as unknown as VideoCard[];
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...list.filter((x) => !seen.has(x.id))];
        });
      }
      setPage(p);
      setPages(res?.pagination?.pages || 1);
      setErr(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setErr((e as Error).message || "搜索失败");
    } finally {
      if (seq === seqRef.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };

  const changeTab = (next: "video" | "post") => {
    if (next === tab) return;
    setTab(next);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    setErr(null);
    if (submitted) void run(submitted, 1, next);
  };

  const submit = (keyword: string) => {
    const k = keyword.trim();
    if (!k) return;
    setSubmitted(k);
    addSearch(k);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    run(k, 1);
  };

  const querying = submitted.length > 0;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="ios-page-heading shrink-0"><h1 className="ios-page-title">搜索</h1></div>
      {/* 搜索栏 */}
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5" >
        <Form className="ios-search-form flex-1 flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索短剧、帖子、题材…"
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="关闭" type="button" onClick={() => { seqRef.current++; busy.current = false; setLoading(false); setQ(""); setSubmitted(""); setItems([]); setPosts([]); }} className="ios-icon-button ios-search-clear"><IClose size={16} /></Button>}
        </Form>
        <Button onClick={() => push({ kind: "ranks" })} aria-label="排行榜"
          variant="primary" className="ios-icon-button ios-search-shortcut">
          <ITrophy size={19} />
        </Button>
      </div>

      <div className="flex-1 scroll-y px-4 pb-24">
        {!querying ? (
          <>
            <Surface role="region" aria-label="热搜榜" className="mt-1 rounded-(--r-md) bg-s2 p-3.5 a-rise">
                <div className="flex items-center justify-between">
                  <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热搜榜</h2>
                  <Button onClick={() => void refreshHot()} disabled={hotLoading} aria-label="刷新热搜榜"
                    className="flex items-center gap-1 px-2 text-[12px] text-mut pressable">
                    {hotLoading ? <Loader className="w-3 h-3" /> : <IRefresh size={12} />}{hotLoading ? "刷新中" : "刷新"}
                  </Button>
                </div>
                {hotError && <p role="status" className="mt-2 text-[12px] text-mut leading-relaxed">
                  {hotVideos.length > 0 ? "刷新失败，保留上次榜单。" : "热搜榜暂不可用。"}{hotError}
                </p>}
                {hotVideos.length > 0 ? (
                  <ol className="ios-search-hot-grid mt-3" aria-busy={hotLoading}>
                    {hotVideos.map((video, i) => (
                      <li key={video.video_id} className="min-w-0">
                        <Button aria-label={`播放 ${video.title}`} title={video.title} className="ios-search-hot-item"
                          onClick={() => push({ kind: "feed", videoIds: hotVideos.map(item => item.video_id), index: i, title: "热搜榜" })}>
                          <span aria-hidden="true" className={`ios-search-hot-rank ${i < 3 ? "text-primary" : "text-mut"}`}>{String(i + 1).padStart(2, "0")}</span>
                          <span className="ios-search-hot-content">
                            <span className="ios-search-hot-title">{video.title}</span>
                            {video.plays && <span className="ios-search-hot-plays"><IPlayF size={10} />{video.plays}</span>}
                          </span>
                          <IChevR size={15} className="text-mut" />
                        </Button>
                      </li>
                    ))}
                  </ol>
                ) : !hotError && <p role="status" className="mt-3 text-[12px] text-mut">{hotLoading ? "加载中…" : "暂无热搜影片"}</p>}
              </Surface>

            {searchHist.length > 0 && (
              <div className="mt-1 a-rise">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-bold text-on">搜索历史</span>
                  <Button onClick={clearSearchHist} className="text-[12px] text-dim pressable">清空</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2.5">
                  {searchHist.map((h) => (
                    <Button key={h} onClick={() => { setQ(h); submit(h); }} className="px-3.5 h-8 rounded-(--r-ctl) bg-s3 text-[13px] text-on/80 pressable">{h}</Button>
                  ))}
                </div>
              </div>
            )}

            <Surface className="mt-5 rounded-(--r-md) bg-s2 p-3.5 a-rise">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[14px] font-semibold text-on/90"><IFireF size={15} className="text-primary" />热门题材</span>
                <Button onClick={() => push({ kind: "ranks" })} className="text-[12px] text-primary font-semibold pressable">完整榜单 ›</Button>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                {HOT_TAGS.map((t) => (
                  <Button key={t} onClick={() => { setQ(t); submit(t); }}
                    className="px-3 h-7 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">{t}</Button>
                ))}
              </div>
            </Surface>

            <div className="flex items-center justify-between mt-6 mb-2.5">
              <span className="text-[14px] font-bold text-on">为你推荐</span>
              <Button onClick={() => submit(HOT_TAGS[Math.floor(Math.random() * HOT_TAGS.length)])}
                className="flex items-center gap-1 text-[12px] text-mut pressable"><IRefresh size={13} />换一批</Button>
            </div>
            <p className="text-[12px] text-dim leading-relaxed">
              输入关键词后按回车搜索，也可以点上面的题材直接看片单。
            </p>
          </>
        ) : (
          <>
            <SegmentedControl className="mt-1 mb-3" aria-label="搜索结果类型" activeIndex={tab === "video" ? 0 : 1}>
              {([["video", "视频"], ["post", "帖子"]] as const).map(([k, label]) => (
                <Button aria-pressed={tab === k} key={k} onClick={() => changeTab(k)}>{label}</Button>
              ))}
            </SegmentedControl>
            <div className="text-[12px] text-mut mb-2.5">「{submitted}」共 <span className="text-primary font-bold">{tab === "video" ? items.length : posts.length}</span> 条结果</div>
            {(tab === "video" ? items.length : posts.length) ? (
              <>
                {tab === "video" ? (
                  <Masonry videos={items} wide={wide} onOpen={(v) => push({ kind: "feed", videoIds: items.map((x) => x.id), index: items.findIndex((x) => x.id === v.id), title: `搜索 · ${submitted}` })} />
                ) : (
                  <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                    {posts.map((post) => (
                      <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => push({ kind: "post", id: post.id })} />
                    ))}
                  </div>
                )}
                <div className="flex justify-center py-4">
                  {loading ? <Loader className="w-6 h-6 spinner" />
                    : page < pages ? (
                      <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button>
                    ) : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}
                </div>
              </>
            ) : loading ? (
              <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
            ) : (
              <Empty icon={<ISearch size={26} />} title={err || "没有找到相关内容"} sub="换个关键词试试，比如「都市」「逆袭」"
                action="看看热榜" onAction={() => push({ kind: "ranks" })} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 排行榜 ================= */
const RANK_TABS = [
  { k: "hot", label: "热播榜", desc: "按热力指数排序" },
  { k: "recommend", label: "推荐榜", desc: "按推荐值排序" },
  { k: "potential", label: "潜力榜", desc: "按潜力值排序" },
] as const;

export function RankPage({ onBack, wide }: { onBack: () => void; wide: boolean }) {
  const { push, toast } = useStore();
  const [tab, setTab] = useState<"hot" | "recommend" | "potential">("hot");
  const [items, setItems] = useState<RankItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.rank(tab)
      .then((res) => { if (alive) setItems(res?.items || []); })
      .catch((e) => { if (alive) { setItems([]); toast((e as Error).message || "榜单加载失败", "info"); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, toast]);

  const max = Math.max(1, ...items.map((x) => x.metric_value || 0));
  const meta = RANK_TABS.find((t) => t.k === tab)!;

  return (
    <div className="ios-page absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 relative overflow-hidden bg-s1" style={{ paddingTop: "var(--sat, 0px)" }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(90% 120% at 100% 0%, var(--p-pc) 0%, transparent 60%)", opacity: 0.32 }} />
        <div className="relative px-3 pt-2 pb-4">
          <Button aria-label="返回" onClick={onBack} className="w-10 h-10 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable"><IBack size={20} /></Button>
          <div className="px-2 mt-1 flex items-end justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-(--r-sm) bg-pc text-on-pc flex items-center justify-center"><ITrophy size={20} /></span>
                <span className="text-[24px] font-bold tracking-wide text-on">HG 热榜</span>
              </div>
              <div className="text-[12px] text-mut mt-1">{meta.desc} · 每 10 分钟更新</div>
            </div>
          </div>
          <SegmentedControl className="mt-3" aria-label="榜单类型" activeIndex={RANK_TABS.findIndex(item => item.k === tab)}>
            {RANK_TABS.map((t) => (
              <Button aria-pressed={tab === t.k} key={t.k} onClick={() => setTab(t.k)}>{t.label}</Button>
            ))}
          </SegmentedControl>
        </div>
      </div>

      <div className="flex-1 scroll-y px-3.5 pt-3 pb-8">
        {loading ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : items.length ? (
          items.map((it) => (
            <RankRow key={`${it.video_id}-${it.rank}`} item={it} metricMax={max}
              onOpen={() => push({ kind: "feed", videoIds: items.map((x) => x.video_id), index: items.findIndex((x) => x.video_id === it.video_id), title: "HG 热榜" })} />
          ))
        ) : (
          <Empty icon={<ITrophy size={26} />} title="榜单暂时为空" sub="稍后再来看看，或者去首页刷刷推荐" />
        )}
        {wide && <div className="h-2" />}
      </div>
    </div>
  );
}

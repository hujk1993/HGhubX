import { Button, Form, Input } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useRef, useState } from "react";
import { api, fmt } from "../api";
import type { Post, VideoCard } from "../types";
import { MediaCard, Masonry } from "./cards";
import { Empty, Img } from "./ui";
import { IBack, IClose, IFireF, ISearch } from "../icons";

/** 栏目内就地搜索：不跳转全局搜索页，在当前栏目内直接搜索并就地展示结果。
 *  kind="post" 走 type=post（帖子，默认称谓吃瓜帖），kind="video" 走 type=video（短剧）。 */
export function InplaceSearch({ kind, postLabel = "吃瓜帖", scope, onOpenVideo, onOpenPost, onClose, wide }: {
  kind: "video" | "post";
  /** post 搜索里的内容称谓，默认沿用「吃瓜帖」，博客页可传「博客帖子」。 */
  postLabel?: string;
  /** 视频搜索范围；原创频道只显示 is_original=1 的条目。 */
  scope?: "original";
  onOpenVideo?: (v: VideoCard, list: VideoCard[]) => void;
  onOpenPost?: (p: Post) => void;
  onClose: () => void;
  wide?: boolean;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<VideoCard[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  /* 请求序号：新关键词或清空时自增，过期请求的结果直接丢弃 */
  const seqRef = useRef(0);

  const run = async (keyword: string, p: number) => {
    if (p > 1 && busy.current) return;
    const seq = p === 1 ? ++seqRef.current : seqRef.current;
    busy.current = true;
    setLoading(true);
    try {
      const res = kind === "post"
        ? await api.searchPosts(keyword, p, 20)
        : await api.search(keyword, p, 20, "video");
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
        const scoped = scope === "original" ? list.filter((v) => v.is_original === 1) : list;
        setItems((prev) => {
          const base = p === 1 ? [] : prev;
          const seen = new Set(base.map((x) => x.id));
          return [...base, ...scoped.filter((x) => !seen.has(x.id))];
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

  const submit = (k: string) => {
    const kk = k.trim();
    if (!kk) return;
    setSubmitted(kk);
    setItems([]);
    setPosts([]);
    setPage(0);
    setPages(1);
    run(kk, 1);
  };

  const count = kind === "post" ? posts.length : items.length;
  const videoLabel = scope === "original" ? "原创" : "短剧";

  return (
    <div className="ios-page absolute inset-0 z-20 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2.5 bg-s1" style={{ paddingTop: "calc(var(--sat, 0px) + 12px)" }}>
        <Button onClick={onClose} className="w-9 h-9 rounded-full flex items-center justify-center text-on hover:bg-s3 pressable" aria-label="退出搜索"><IBack size={19} /></Button>
        <Form className="flex-1 flex items-center gap-2 h-11 rounded-(--r-ctl) bg-s3 px-3.5 focus-within:bg-s4 transition-colors"
          onSubmit={(e) => { e.preventDefault(); submit(q); }}>
          <ISearch size={17} className="text-mut shrink-0" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "post" ? `搜索${postLabel}…` : `搜索${videoLabel}…`}
            className="flex-1 min-w-0 bg-transparent text-[14px] text-on placeholder-dim outline-none" />
          {q && <Button aria-label="关闭" type="button" onClick={() => { seqRef.current++; busy.current = false; setLoading(false); setErr(null); setQ(""); setSubmitted(""); setItems([]); setPosts([]); }} className="w-5 h-5 rounded-full bg-s4 flex items-center justify-center text-mut pressable"><IClose size={11} /></Button>}
        </Form>
      </div>

      <div className="flex-1 scroll-y px-4 pt-3 pb-8">
        {!submitted ? (
          <div className="flex justify-center py-20"><span className="text-[13px] text-mut">{kind === "post" ? `输入关键词，在本栏目内搜索${postLabel}` : `输入关键词，在本栏目内搜索${videoLabel}`}</span></div>
        ) : loading && !count ? (
          <div className="flex justify-center py-12"><Loader className="w-8 h-8 spinner" /></div>
        ) : count ? (
          kind === "post" ? (
            <>
              <div className="text-[12px] text-mut mb-2.5">「{submitted}」共 <span className="text-primary font-bold">{count}</span> 条{postLabel}</div>
              <div className={`ios-media-grid ${wide ? "is-wide" : ""}`}>
                {posts.map((post) => (
                  <MediaCard key={post.id} title={post.title} cover={post.cover} subtitle={`${fmt(post.hot)} 次浏览`} onOpen={() => onOpenPost?.(post)} />
                ))}
              </div>
              <div className="flex justify-center py-4">
                {loading ? <Loader className="w-6 h-6 spinner" /> : page < pages ? <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button> : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}
              </div>
            </>
          ) : (
            <>
              <div className="text-[12px] text-mut mb-2.5">「{submitted}」共 <span className="text-primary font-bold">{count}</span> 条{videoLabel}</div>
              <Masonry videos={items} wide={wide} onOpen={(v) => onOpenVideo?.(v, items)} />
              <div className="flex justify-center py-4">
                {loading ? <Loader className="w-6 h-6 spinner" /> : page < pages ? <Button onClick={() => run(submitted, page + 1)} className="px-5 h-9 rounded-(--r-ctl) bg-s3 text-[13px] text-on/85 pressable">加载更多</Button> : <span className="text-[12px] text-dim">— 已经到底啦 —</span>}
              </div>
            </>
          )
        ) : (
          <Empty icon={<ISearch size={26} />} title={err || "没有找到相关内容"} sub="换个关键词试试" />
        )}
      </div>
    </div>
  );
}
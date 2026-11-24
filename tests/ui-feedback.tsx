import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore, useToasts } from "../src/shared/model/store";
import Profile from "../src/features/account/Profile";
import { ToastHost } from "../src/shared/ui/ui";
import { useFeedActions } from "../src/features/feed/useFeedActions";
import type { VideoHandle } from "../src/features/playback";
import "../src/index.css";

// 探针：把真实的 toast() 与当前 toast 列表暴露给回归脚本。
// toast 列表来自模块级外部 store（useToasts），与 ToastHost 渲染的是同一份数据。
function Probe() {
  const { toast } = useStore();
  const toasts = useToasts();
  useEffect(() => {
    Object.assign(window, { uiFeedbackProbe: { toast, toasts: () => toasts } });
  }, [toast, toasts]);
  return null;
}

// 探针：挂载真实的 useFeedActions，用同一份 store toast 验证点赞/收藏提示共用单槽。
function FeedActionsProbe() {
  const { toast } = useStore();
  const mounted = useRef(true);
  const actionContext = useRef({ accountScope: "guest", lineEpoch: 0, id: 1, ep: 1, kind: "video" as const });
  const videoRef = useRef<VideoHandle | null>(null);
  const liked = useRef(false);
  const collected = useRef(false);
  const actions = useFeedActions({
    videoRef, mounted, actionContext, accountScope: "guest", lineEpoch: 0, curId: 1, curEp: 1, kind: "video",
    meta: { title: "示例", cover: "", desc: "", author: "作者", authorId: 7, tags: [], score: 0, like: 1, comment: 0, collect: 0, episodes: [] },
    detail: undefined, posts: {}, user: null, setLoginOpen: () => {}, follows: [],
    isLiked: () => liked.current, isFav: () => collected.current,
    setLiked: async (_kind, _id, _ep, on) => { liked.current = on; },
    setCollected: async (_kind, _id, on) => { collected.current = on; },
    setFollowing: async () => {}, actionPending: () => false, toast,
  });
  useEffect(() => {
    Object.assign(window, { feedActionProbe: { like: () => actions.onLike(), fav: () => actions.onFav() } });
  }, [actions]);
  return null;
}

// Profile 是真实的 .ios-page 消费者：
//   .ios-page > .ios-page-heading.shrink-0（标题头栏）
//   .ios-page > .ios-page-body.scroll-y（滚动体）
// 宽屏限宽居中契约直接量这两个直接子元素的几何。
createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Profile wide={true} />
    <ToastHost />
    <Probe />
    <FeedActionsProbe />
  </AppProvider>,
);

import type { VideoCard } from "../api/types";

/** Metric order for channel and tag video lists. */
export type VideoSortMetric = "default" | "like_count" | "collect_count" | "hot" | "score";
export type VideoSortDirection = "desc" | "asc";

export const VIDEO_SORT_METRICS = ["like_count", "collect_count", "hot", "score"] as const;

export function isVideoSortMetric(value: string): value is VideoSortMetric {
  return value === "default" || (VIDEO_SORT_METRICS as readonly string[]).includes(value);
}

export function videoSortLabel(metric: VideoSortMetric, tr: (key: string) => string): string {
  switch (metric) {
    case "like_count": return tr("点赞数");
    case "collect_count": return tr("收藏数");
    case "hot": return tr("播放数");
    case "score": return tr("评分");
    default: return tr("默认排序");
  }
}

/**
 * Stable sort by a public metric. `desc` is high-to-low, `asc` low-to-high.
 * Pages are fetched in source order first, so equal metrics keep that order.
 */
export function sortVideosByMetric(
  videos: VideoCard[],
  metric: VideoSortMetric,
  direction: VideoSortDirection = "desc",
): VideoCard[] {
  if (metric === "default") return videos;
  const key = metric;
  const ascending = direction === "asc";
  return videos
    .map((video, index) => ({ video, index }))
    .sort((a, b) => {
      const diff = (Number(a.video[key]) || 0) - (Number(b.video[key]) || 0);
      return (ascending ? diff : -diff) || a.index - b.index;
    })
    .map(item => item.video);
}

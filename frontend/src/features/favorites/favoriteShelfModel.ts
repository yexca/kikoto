import type { FavoriteList, ListeningStatus, Work } from "@/lib/api";

/** Status filters in shelf order; Unmarked only appears while it holds works or is selected. */
export const favoriteStatusOrder: ListeningStatus[] = [
  "want_to_listen",
  "listening",
  "finished",
  "relisten",
  "paused",
  "none",
];

export type FavoriteStatusFilterOption = {
  value: ListeningStatus | "all";
  count: number;
};

export function favoriteStatusFilterOptions(
  statusCounts: Record<string, number>,
  shelfTotal: number,
  selected: ListeningStatus | "all",
): FavoriteStatusFilterOption[] {
  const options: FavoriteStatusFilterOption[] = [{ value: "all", count: shelfTotal }];
  for (const status of favoriteStatusOrder) {
    const count = statusCounts[status] ?? 0;
    if (status === "none" && count === 0 && selected !== "none") continue;
    options.push({ value: status, count });
  }
  return options;
}

export type FavoriteShelfProgress = {
  total: number;
  /** Finished or queued for a relisten. */
  listened: number;
  listening: number;
  queued: number;
  /** Whole percent of the shelf already listened to. */
  percent: number;
};

export function favoriteShelfProgress(statusCounts: Record<string, number>): FavoriteShelfProgress {
  const count = (status: ListeningStatus) => Math.max(0, statusCounts[status] ?? 0);
  const total = favoriteStatusOrder.reduce((sum, status) => sum + count(status), 0);
  const listened = count("finished") + count("relisten");
  return {
    total,
    listened,
    listening: count("listening"),
    queued: count("want_to_listen"),
    percent: total > 0 ? Math.round((listened / total) * 100) : 0,
  };
}

/** Distinct covers for the shelf artwork, in result order. */
export function favoriteShelfCovers(works: Pick<Work, "coverUrl">[], limit = 4) {
  const covers: string[] = [];
  for (const work of works) {
    const cover = work.coverUrl.trim();
    if (!cover || covers.includes(cover)) continue;
    covers.push(cover);
    if (covers.length === limit) break;
  }
  return covers;
}

export type FavoriteShelfKind = "all" | "marked" | "list";

export function favoriteShelfKind(activeList: "all" | number, markedList: FavoriteList | null): FavoriteShelfKind {
  if (activeList === "all") return "all";
  return markedList?.id === activeList ? "marked" : "list";
}

/** Remaining time on the saved resume track, or null when its length is unknown. */
export function favoriteResumeRemainingSeconds(progress: Work["progress"]) {
  const duration = progress.durationSeconds;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.round(duration - Math.min(progress.positionSeconds, duration)));
}

export function favoriteResumeFraction(progress: Work["progress"]) {
  const duration = progress.durationSeconds;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, Math.max(0, progress.positionSeconds / duration));
}

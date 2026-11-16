import type { FavoriteList, ListeningStatus, Work } from "@/lib/api";
import type { FavoriteStatusFilter } from "./favoritesBrowseState";

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
  value: FavoriteStatusFilter;
  count: number;
};

/** Every work, any Quick mark, then each mark in shelf order. */
export function favoriteStatusFilterOptions(
  statusCounts: Record<string, number>,
  shelfTotal: number,
  selected: FavoriteStatusFilter,
): FavoriteStatusFilterOption[] {
  const marked = favoriteStatusOrder.reduce(
    (sum, status) => (status === "none" ? sum : sum + Math.max(0, statusCounts[status] ?? 0)),
    0,
  );
  const options: FavoriteStatusFilterOption[] = [
    { value: "all", count: shelfTotal },
    { value: "marked", count: marked },
  ];
  for (const status of favoriteStatusOrder) {
    const count = statusCounts[status] ?? 0;
    if (status === "none" && count === 0 && selected !== "none") continue;
    options.push({ value: status, count });
  }
  return options;
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

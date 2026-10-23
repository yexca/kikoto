import type { TFunction } from "i18next";

import type { LibrarySource } from "@/lib/libraryApi";
import type { RankingItem, RankingList, RankingPage } from "@/lib/rankingApi";
import { parseServerTimestamp } from "@/lib/serverTimestamp";

/** The filters above a ranking; each narrows the items of the shown snapshot. */
export const RANKING_FILTERS = ["all", "new", "moved", "notInLibrary"] as const;
export type RankingFilter = (typeof RANKING_FILTERS)[number];

export const RANKING_DEPTHS = [10, 20, 50, 100] as const;

/** Remote sources whose popular list a ranking can follow: enabled compatible sources. */
export function isRankingSource(source: LibrarySource): boolean {
  return source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType);
}

export const RANKING_INTERVAL_HOURS = [1, 6, 12, 24, 48, 168] as const;

/** A list's name from its provider, period, and window, or its source's name. */
export function rankingListLabel(list: RankingList, t: TFunction): string {
  if (list.provider === "remote_source") {
    return `${list.sourceName || t("subscriptions.rankings.remoteSource")} · ${t("subscriptions.rankings.popular")}`;
  }
  const parts = [t("subscriptions.rankings.dlsite")];
  if (list.period) parts.push(t(`subscriptions.rankings.periods.${list.period}`));
  if (list.releaseWindow) parts.push(t("subscriptions.rankings.newReleases"));
  return parts.join(" · ");
}

export function matchesRankingFilter(item: RankingItem, filter: RankingFilter): boolean {
  switch (filter) {
    case "new":
      return item.change.kind === "new" || item.change.kind === "reentered";
    case "moved":
      return item.change.kind === "up" || item.change.kind === "down";
    case "notInLibrary":
      return item.work === null;
    default:
      return true;
  }
}

export function rankingFilterCounts(page: RankingPage): Record<RankingFilter, number> {
  return {
    all: page.items.length,
    new: page.counts.new + page.counts.reentered,
    moved: page.counts.up + page.counts.down,
    notInLibrary: page.counts.notInLibrary,
  };
}

/** Whole days a work has stayed in the list, counting the day it entered as the first. */
export function rankingStreakDays(item: Pick<RankingItem, "streakStartedAt">, now: Date): number {
  const started = parseServerTimestamp(item.streakStartedAt);
  if (!started) return 1;
  return Math.max(1, Math.floor((now.getTime() - started.getTime()) / 86_400_000) + 1);
}

/** The list named by `list` in the location, when it is one of lists, else the first list. */
export function selectedRankingList(lists: RankingList[], requested: number | null): RankingList | null {
  return lists.find((list) => list.id === requested) ?? lists[0] ?? null;
}

export function rankingListFromSearch(search: string): number | null {
  const value = Number(new URLSearchParams(search).get("list"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** `seen` (the default, stored as no value), `previous`, or a snapshot id. */
export function rankingCompareFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("compare") ?? "";
  return value === "previous" || /^[1-9][0-9]*$/.test(value) ? value : "";
}

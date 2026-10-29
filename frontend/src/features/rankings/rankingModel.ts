import type { TFunction } from "i18next";

import type { ResolvedUiLocale } from "@/i18n";
import { dateTimeFormat } from "@/i18n/format";
import type { LibrarySource } from "@/lib/libraryApi";
import type {
  RankingItem,
  RankingList,
  RankingListRequest,
  RankingOrder,
  RankingPage,
  RankingVariant,
} from "@/lib/rankingApi";
import { parseServerTimestamp } from "@/lib/serverTimestamp";
import {
  EMPTY_SHOWN_WORKS_SOURCE_CHECK,
  shownWorkOnSource,
  type ShownWorksSourceCheck,
} from "@/lib/shownWorksSourceCheck";

/** The filters above a ranking; each narrows the items of the shown snapshot. */
export const RANKING_FILTERS = ["all", "new", "moved", "notInLibrary", "onSource"] as const;
export type RankingFilter = (typeof RANKING_FILTERS)[number];

/** A finished annual ranking is an archive: it shows ranks without movement. */
export const ARCHIVE_RANKING_FILTERS = ["all", "notInLibrary", "onSource"] as const;

export const RANKING_DEPTHS = [10, 20, 50, 100] as const;

/** Remote sources whose popular list a ranking can follow: enabled compatible sources. */
export function isRankingSource(source: LibrarySource): boolean {
  return source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType);
}

/** What decides a list's pull intervals: its DLsite period, or a remote source's list. */
export type RankingIntervalKind = "day" | "week" | "month" | "year" | "total" | "remote";

export function rankingIntervalKind(list: Pick<RankingList, "provider" | "period">): RankingIntervalKind {
  if (list.provider === "remote_source" || !list.period) return "remote";
  return list.period;
}

const HOUR = 60;
const DAY = 24 * HOUR;

/**
 * The intervals, in minutes, each kind of list offers, and its default. DLsite
 * updates its 24-hour ranking every 20 minutes, its 7-day ranking hourly, and
 * its 30-day ranking daily; the annual and all-time rankings change slowly.
 * The backend checks the same ranges.
 */
export const RANKING_INTERVALS: Record<RankingIntervalKind, { options: readonly number[]; default: number }> = {
  day: { options: [20, 30, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY], default: HOUR },
  week: { options: [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY], default: 6 * HOUR },
  month: { options: [6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY], default: DAY },
  year: { options: [DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY], default: 7 * DAY },
  total: { options: [DAY, 2 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY], default: 7 * DAY },
  remote: { options: [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 3 * DAY, 7 * DAY], default: DAY },
};

/** The interval choices for a list, including its current value when that is not a usual choice. */
export function rankingIntervalOptions(kind: RankingIntervalKind, current: number): number[] {
  const options = [...RANKING_INTERVALS[kind].options];
  if (!options.includes(current)) options.push(current);
  return options.sort((left, right) => left - right);
}

/** How long every change is kept, and how long one order per day is kept; 0 keeps it forever. */
export const RANKING_FULL_RETENTION_DAYS = [7, 14, 30, 60, 90] as const;
export const RANKING_DAILY_RETENTION_DAYS = [180, 365, 730, 1825, 0] as const;

/** A list's name from its provider, period, and year, or its source's name. */
export function rankingListLabel(list: RankingList, t: TFunction): string {
  if (list.provider === "remote_source") {
    return `${list.sourceName || t("subscriptions.rankings.remoteSource")} · ${t("subscriptions.rankings.popular")}`;
  }
  const parts = [t("subscriptions.rankings.dlsite")];
  if (list.period) parts.push(t(`subscriptions.rankings.periods.${list.period}`));
  if (list.period === "year") parts.push(String(list.year));
  return parts.join(" · ");
}

export const DEFAULT_RANKING_ORDER: RankingOrder = { releaseWindow: "", sort: "" };

function isOrder(order: RankingOrder) {
  return (variant: RankingVariant) => variant.releaseWindow === order.releaseWindow && variant.sort === order.sort;
}

/** Whether a list offers the 30-day window: DLsite's 24-hour, 7-day, and 30-day rankings. */
export function rankingOffersReleaseWindow(list: RankingList): boolean {
  return list.variants.some((variant) => variant.releaseWindow === "30d");
}

/** Whether a list offers the sales order: every DLsite ranking. */
export function rankingOffersSalesOrder(list: RankingList): boolean {
  return list.variants.some((variant) => variant.sort === "sale");
}

/**
 * The order a list shows for a requested one: the requested order when the
 * list is pulled in it, else the same sort without the window, else the
 * default.
 */
export function rankingOrderFor(list: RankingList, requested: RankingOrder): RankingOrder {
  const candidates: RankingOrder[] = [requested, { releaseWindow: "", sort: requested.sort }, DEFAULT_RANKING_ORDER];
  return candidates.find((order) => list.variants.some(isOrder(order))) ?? DEFAULT_RANKING_ORDER;
}

/** The variant a list shows for a requested order. */
export function rankingVariantFor(list: RankingList, requested: RankingOrder): RankingVariant | null {
  return list.variants.find(isOrder(rankingOrderFor(list, requested))) ?? list.variants[0] ?? null;
}

/** The order named by `release` and `sort` in the location, or null when it names none. */
export function rankingOrderFromSearch(search: string): RankingOrder | null {
  const params = new URLSearchParams(search);
  if (!params.has("release") && !params.has("sort")) return null;
  return {
    releaseWindow: params.get("release") === "30d" ? "30d" : "",
    sort: params.get("sort") === "sale" ? "sale" : "",
  };
}

/** The location's `release` and `sort` for an order; the default order names neither. */
export function rankingOrderSearch(order: RankingOrder): { release: string | null; sort: string | null } {
  return { release: order.releaseWindow || null, sort: order.sort || null };
}

export function encodeRankingOrder(order: RankingOrder): string {
  return `${order.releaseWindow}/${order.sort}`;
}

export function decodeRankingOrder(value: unknown): RankingOrder | null {
  if (typeof value !== "string") return null;
  const [releaseWindow, sort] = value.split("/");
  if ((releaseWindow !== "" && releaseWindow !== "30d") || (sort !== "" && sort !== "sale")) return null;
  return { releaseWindow, sort };
}

/**
 * One chip above the rankings. The annual lists share one chip, newest year
 * first, so the years do not crowd the bar.
 */
export type RankingChip = { key: string; lists: RankingList[] };

const RANKING_PERIOD_RANK: Record<string, number> = { day: 0, week: 1, month: 2, year: 3, total: 4 };

export function rankingChipKey(list: RankingList): string {
  return list.period === "year" ? "annual" : `list:${list.id}`;
}

/**
 * The chips in their fixed order: DLsite 24 hours, 7 days, 30 days, Annual,
 * and All time, then each remote source's popular list in the order the
 * lists arrive, which is the sources' configured order.
 */
export function rankingChips(lists: RankingList[]): RankingChip[] {
  const rank = (list: RankingList) => (list.provider === "remote_source" ? 5 : (RANKING_PERIOD_RANK[list.period] ?? 5));
  const chips: RankingChip[] = [];
  for (const list of [...lists].sort((left, right) => rank(left) - rank(right))) {
    const key = rankingChipKey(list);
    const chip = chips.find((candidate) => candidate.key === key);
    if (chip) chip.lists.push(list);
    else chips.push({ key, lists: [list] });
  }
  for (const chip of chips) chip.lists.sort((left, right) => right.year - left.year);
  return chips;
}

/** Whether a chip has an unread update in the order it shows. */
export function rankingChipUnseen(chip: RankingChip, order: RankingOrder): boolean {
  return chip.lists.some((list) => rankingVariantFor(list, order)?.unseen ?? false);
}

/**
 * The order each chip shows: the location's for the shown chip, else the one
 * last chosen for the chip, else the default.
 */
export function rankingChipOrder(
  chip: RankingChip,
  shown: { chipKey: string | null; order: RankingOrder | null },
  preferences: Readonly<Record<string, RankingOrder>>,
): RankingOrder {
  if (chip.key === shown.chipKey && shown.order) return shown.order;
  return preferences[chip.key] ?? DEFAULT_RANKING_ORDER;
}

/** The chip a location shows: the one holding the named list, else the first. */
export function shownRankingChip(chips: RankingChip[], requestedListId: number | null): RankingChip | null {
  return chips.find((chip) => chip.lists.some((list) => list.id === requestedListId)) ?? chips[0] ?? null;
}

/** Whether any shown chip has an unread update in the order it shows. */
export function rankingsUnseen(
  lists: RankingList[],
  requestedListId: number | null,
  locationOrder: RankingOrder | null,
  preferences: Readonly<Record<string, RankingOrder>>,
): boolean {
  const chips = rankingChips(lists.filter((list) => list.enabled));
  const shown = { chipKey: shownRankingChip(chips, requestedListId)?.key ?? null, order: locationOrder };
  return chips.some((chip) => rankingChipUnseen(chip, rankingChipOrder(chip, shown, preferences)));
}

export function rankingChipLabel(chip: RankingChip, t: TFunction): string {
  const group = rankingChipGroupLabel(chip, t);
  return `${group} · ${rankingChipSegmentLabel(chip, t)}`;
}

function rankingChipGroupKey(chip: RankingChip): string {
  const list = chip.lists[0];
  return list.provider === "remote_source" ? `source:${list.sourceId ?? 0}` : "dlsite";
}

function rankingChipGroupLabel(chip: RankingChip, t: TFunction): string {
  const list = chip.lists[0];
  if (list.provider === "remote_source") return list.sourceName || t("subscriptions.rankings.remoteSource");
  return t("subscriptions.rankings.dlsite");
}

/** A chip's name within its provider's group: the DLsite period, or a remote source's popular list. */
export function rankingChipSegmentLabel(chip: RankingChip, t: TFunction): string {
  const list = chip.lists[0];
  if (list.provider === "remote_source" || !list.period) return t("subscriptions.rankings.popular");
  return t(`subscriptions.rankings.periods.${list.period}`);
}

/** The chips of one provider, named once: DLsite's periods, or one remote source's popular list. */
export type RankingChipGroup = { key: string; label: string; chips: RankingChip[] };

/** The chips grouped by provider, keeping their fixed order. */
export function rankingChipGroups(chips: RankingChip[], t: TFunction): RankingChipGroup[] {
  const groups: RankingChipGroup[] = [];
  for (const chip of chips) {
    const key = rankingChipGroupKey(chip);
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.chips.push(chip);
    else groups.push({ key, label: rankingChipGroupLabel(chip, t), chips: [chip] });
  }
  return groups;
}

export function matchesRankingFilter(
  item: RankingItem,
  filter: RankingFilter,
  check: ShownWorksSourceCheck = EMPTY_SHOWN_WORKS_SOURCE_CHECK,
): boolean {
  switch (filter) {
    case "new":
      return item.change.kind === "new" || item.change.kind === "reentered";
    case "moved":
      return item.change.kind === "up" || item.change.kind === "down";
    case "notInLibrary":
      return !item.inLibrary;
    case "onSource":
      return shownWorkOnSource(item, check);
    default:
      return true;
  }
}

export function rankingFilterCounts(
  page: RankingPage,
  check: ShownWorksSourceCheck = EMPTY_SHOWN_WORKS_SOURCE_CHECK,
): Record<RankingFilter, number> {
  return {
    all: page.items.length,
    new: page.counts.new + page.counts.reentered,
    moved: page.counts.up + page.counts.down,
    notInLibrary: page.counts.notInLibrary,
    onSource: page.items.filter((item) => shownWorkOnSource(item, check)).length,
  };
}

/** Whole days a work has stayed in the list, counting the day it entered as the first. */
export function rankingStreakDays(item: Pick<RankingItem, "streakStartedAt">, now: Date): number {
  const started = parseServerTimestamp(item.streakStartedAt);
  if (!started) return 1;
  return Math.max(1, Math.floor((now.getTime() - started.getTime()) / 86_400_000) + 1);
}

/**
 * The facts an entry states beside its title, only when they say something:
 * a stay longer than the day it entered, and a best rank above the current one.
 */
export function rankingEntryFacts(
  item: Pick<RankingItem, "rank" | "bestRank" | "streakStartedAt">,
  now: Date,
): { streakDays: number | null; bestRank: number | null } {
  const days = rankingStreakDays(item, now);
  return {
    streakDays: days > 1 ? days : null,
    bestRank: item.bestRank > 0 && item.bestRank < item.rank ? item.bestRank : null,
  };
}

/** The most recent pull of any list, or null when none was pulled. */
export function latestRankingPull(lists: RankingList[]): string | null {
  let latest: { value: string; time: number } | null = null;
  for (const list of lists) {
    const time = parseServerTimestamp(list.lastPulledAt)?.getTime();
    if (time !== undefined && list.lastPulledAt && (!latest || time > latest.time))
      latest = { value: list.lastPulledAt, time };
  }
  return latest?.value ?? null;
}

/** The list named by `list` in the location, when it is one of lists, else the first list. */
export function selectedRankingList(lists: RankingList[], requested: number | null): RankingList | null {
  return lists.find((list) => list.id === requested) ?? lists[0] ?? null;
}

export function rankingListFromSearch(search: string): number | null {
  const value = Number(new URLSearchParams(search).get("list"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** The default (stored as no value), `previous`, a snapshot id, or an ISO time to compare with. */
export function rankingCompareFromSearch(search: string): string {
  const value = new URLSearchParams(search).get("compare") ?? "";
  if (value === "previous" || /^[1-9][0-9]*$/.test(value)) return value;
  const time = value.includes("T") ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? "" : new Date(time).toISOString();
}

/** A server timestamp or an instant in a time zone, as a date and time or as a time of day. */
export function formatRankingTime(
  value: string | number | null | undefined,
  locale: ResolvedUiLocale,
  timeZone: string,
  part: "dateTime" | "time" = "dateTime",
): string {
  const date = typeof value === "number" ? new Date(value) : parseServerTimestamp(value);
  if (!date) return "";
  const options: Intl.DateTimeFormatOptions =
    part === "time" ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" };
  try {
    return dateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return dateTimeFormat(locale, options).format(date);
  }
}

/**
 * A server timestamp in a time zone as briefly as it stays clear: the time of
 * day when it falls on today, the day and time within this year, else the
 * full date and time.
 */
export function formatRankingStamp(
  value: string | null | undefined,
  locale: ResolvedUiLocale,
  timeZone: string,
  now: number,
): string {
  const date = parseServerTimestamp(value);
  if (!date) return "";
  const day = zonedDay(date.getTime(), timeZone);
  const today = zonedDay(now, timeZone);
  const options: Intl.DateTimeFormatOptions =
    day === today
      ? { timeStyle: "short" }
      : day.slice(0, 4) === today.slice(0, 4)
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { dateStyle: "medium", timeStyle: "short" };
  try {
    return dateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    return dateTimeFormat(locale, options).format(date);
  }
}

/**
 * A server timestamp relative to now ("12 min. ago", "in 2 hr."), or the day
 * in a time zone when it is more than 45 days away.
 */
export function formatRankingRelative(
  value: string | null | undefined,
  locale: ResolvedUiLocale,
  timeZone: string,
  now: number,
): string {
  const date = parseServerTimestamp(value);
  if (!date) return "";
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (abs < 45) return format.format(0, "second");
  if (abs < 90 * 60) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 36 * 3600) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 45 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
  try {
    return dateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);
  } catch {
    return dateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  }
}

/** The history time named by `at` in the location, as an ISO instant, or null for the latest. */
export function rankingAtFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("at");
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A server timestamp as an ISO instant, for the location and the API. */
export function rankingInstant(value: string): string {
  return parseServerTimestamp(value)?.toISOString() ?? value;
}

/** The offset of a time zone from UTC at an instant, in milliseconds. */
function zoneOffset(time: number, timeZone: string): number {
  try {
    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (const part of format.formatToParts(time)) parts[part.type] = part.value;
    const wall = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return wall - (time - (((time % 1000) + 1000) % 1000));
  } catch {
    return 0;
  }
}

/** The calendar day (YYYY-MM-DD) an instant falls on in a time zone. */
export function zonedDay(time: number, timeZone: string): string {
  return new Date(time + zoneOffset(time, timeZone)).toISOString().slice(0, 10);
}

/** The instants a calendar day starts and ends at in a time zone. */
export function zonedDayRange(day: string, timeZone: string): { start: number; end: number } {
  const startOf = (value: string) => {
    const midnight = Date.parse(`${value}T00:00:00Z`);
    let start = midnight - zoneOffset(midnight, timeZone);
    start = midnight - zoneOffset(start, timeZone);
    return start;
  };
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { start: startOf(day), end: startOf(next) };
}

/**
 * The time a history day shows: the end of the day, or now for today, so the
 * page shows the order in effect when the day ended.
 */
export function rankingDayAt(day: string, timeZone: string, now: number): string {
  const { end } = zonedDayRange(day, timeZone);
  return new Date(Math.min(end - 1000, now)).toISOString();
}

/** Whether only the end-of-day order is kept for a day: it ended before the full history starts. */
export function rankingDayIsDailyOnly(day: string, timeZone: string, fullFrom: string): boolean {
  const from = parseServerTimestamp(fullFrom);
  return from !== null && zonedDayRange(day, timeZone).end <= from.getTime();
}

/** One settings row: a ranking that can be shown, whether or not its list exists yet. */
export type RankingSettingRow = {
  key: string;
  request: RankingListRequest;
  list: RankingList | null;
  kind: RankingIntervalKind;
  label: string;
};

function sameRanking(list: RankingList, request: RankingListRequest): boolean {
  if (list.provider !== request.provider) return false;
  if (request.provider === "remote_source") return list.sourceId === request.sourceId;
  return list.period === request.period && list.year === (request.year ?? 0);
}

export type RankingSettingRows = {
  /** The 24-hour, 7-day, and 30-day rankings. */
  dlsite: RankingSettingRow[];
  /** The annual ranking of the year in progress. */
  currentYear: RankingSettingRow;
  /** Annual lists of earlier years, newest first. */
  pastYears: RankingSettingRow[];
  /** Years from 2000 that have no list yet, newest first. */
  addableYears: number[];
  total: RankingSettingRow;
  remote: RankingSettingRow[];
};

/**
 * The fixed settings rows, in the order of the chips: the DLsite 24-hour,
 * 7-day, and 30-day rankings, the annual ranking of the year in progress and
 * the earlier years already added, the all-time ranking, and each enabled
 * compatible remote source. A row without a list is created when it is first
 * shown.
 */
export function rankingSettingRows(
  lists: RankingList[],
  sources: LibrarySource[],
  currentYear: number,
  t: TFunction,
): RankingSettingRows {
  const row = (request: RankingListRequest, label: string): RankingSettingRow => {
    const list = lists.find((candidate) => sameRanking(candidate, request)) ?? null;
    return {
      key: `${request.provider}:${request.sourceId ?? ""}:${request.period ?? ""}:${request.year ?? ""}`,
      request,
      list,
      kind: rankingIntervalKind({ provider: request.provider, period: request.period ?? "" }),
      label,
    };
  };
  const period = (value: "day" | "week" | "month" | "total") =>
    row({ provider: "dlsite", period: value }, t(`subscriptions.rankings.periods.${value}`));
  const dlsite = (["day", "week", "month"] as const).map(period);
  const annual = (year: number) => row({ provider: "dlsite", period: "year", year }, String(year));
  const pastYears = lists
    .filter((list) => list.period === "year" && list.year < currentYear)
    .sort((left, right) => right.year - left.year)
    .map((list) => annual(list.year));
  const added = new Set(lists.filter((list) => list.period === "year").map((list) => list.year));
  const addableYears: number[] = [];
  for (let year = currentYear - 1; year >= 2000; year--) if (!added.has(year)) addableYears.push(year);
  const rankingSources = sources.filter(isRankingSource);
  const remote = rankingSources.map((source) =>
    row({ provider: "remote_source", sourceId: source.id }, source.displayName),
  );
  for (const list of lists) {
    if (list.provider === "remote_source" && !rankingSources.some((source) => source.id === list.sourceId)) {
      remote.push(
        row(
          { provider: "remote_source", sourceId: list.sourceId ?? 0 },
          list.sourceName || t("subscriptions.rankings.remoteSource"),
        ),
      );
    }
  }
  return { dlsite, currentYear: annual(currentYear), pastYears, addableYears, total: period("total"), remote };
}

/** A wall-clock time (YYYY-MM-DDTHH:mm) in a time zone as an ISO instant, or null when it is not one. */
export function zonedWallTime(value: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  // The wall-clock time read as UTC, moved by the zone's offset at that time,
  // so a day that changes daylight saving time keeps the chosen hour.
  const wall = Date.parse(`${value}:00Z`);
  if (Number.isNaN(wall)) return null;
  const instant = wall - zoneOffset(wall - zoneOffset(wall, timeZone), timeZone);
  return new Date(instant).toISOString();
}

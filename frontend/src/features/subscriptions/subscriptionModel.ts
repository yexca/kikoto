import type { TFunction } from "i18next";

import type {
  CreatorSubscription,
  CreatorSubscriptionLookup,
  ReleaseFeedEvent,
  ReleaseFeedFamily,
  ReleaseFeedSubject,
} from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";
import { voiceDetailPath } from "@/lib/voiceRoute";

/** The settings panel beside the page: subscriptions with their schedule, rankings, or Availability Watch. */
export const SUBSCRIPTION_PANELS = ["subscriptions", "rankings", "watch"] as const;
export type SubscriptionPanel = (typeof SUBSCRIPTION_PANELS)[number];

/** The page shows new releases from subscriptions, the tracked rankings, or the Availability Watch pool. */
export const SUBSCRIPTION_VIEWS = ["releases", "rankings", "watch"] as const;
export type SubscriptionView = (typeof SUBSCRIPTION_VIEWS)[number];

/**
 * The view named by `view` in the location; New releases when it names none.
 * `panel=watch` without a view names the Watch view, which holds the pool.
 */
export function subscriptionViewFromSearch(search: string): SubscriptionView {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === "rankings" || view === "watch") return view;
  return view === null && params.get("panel") === "watch" ? "watch" : "releases";
}

/** The settings tab that belongs to a view, which the settings button opens. */
export function subscriptionPanelForView(view: SubscriptionView): SubscriptionPanel {
  return view === "releases" ? "subscriptions" : view;
}

/**
 * The query with `panel=watch` and no view written as the Watch view, or null
 * when it needs no change.
 */
export function canonicalSubscriptionSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("panel") !== "watch" || params.has("view")) return null;
  params.delete("panel");
  params.set("view", "watch");
  return `?${params}`;
}

/**
 * A query the page writes names its view whenever the Availability Watch
 * settings are open, since `panel=watch` alone names the Watch view.
 */
export function withExplicitSubscriptionView(params: URLSearchParams): URLSearchParams {
  if (params.get("panel") === "watch" && !params.has("view")) params.set("view", "releases");
  return params;
}

/**
 * What a Watch view link asks for: a target's family (`target=<id>`), or the
 * available works (`dialog=ready`, from notifications).
 */
export function watchLinkFromSearch(search: string): { targetId: number | null; revealAvailable: boolean } | null {
  const params = new URLSearchParams(search);
  const target = Number(params.get("target"));
  const targetId = Number.isInteger(target) && target > 0 ? target : null;
  const revealAvailable = params.get("dialog") === "ready";
  return targetId !== null || revealAvailable ? { targetId, revealAvailable } : null;
}

export const SUBSCRIPTION_INTERVAL_HOURS = [1, 6, 12, 24, 48, 168] as const;

/** Raised after the feed is opened, so the navigation badge clears at once. */
export const RELEASE_FEED_SEEN_EVENT = "kikoto:release-feed-seen";

/**
 * The open settings panel named by `panel` in the location, or null for the
 * view alone. `panel=watch` without a view opens the Watch view, not the panel.
 */
export function subscriptionPanelFromSearch(search: string): SubscriptionPanel | null {
  const params = new URLSearchParams(search);
  const panel = params.get("panel");
  if (panel === "watch" && !params.has("view")) return null;
  return SUBSCRIPTION_PANELS.find((item) => item === panel) ?? null;
}

/** How many days with entries one feed page holds; days without entries are skipped. */
export const RELEASE_FEED_DAY_OPTIONS = [5, 10, 15] as const;
export type ReleaseFeedDayCount = (typeof RELEASE_FEED_DAY_OPTIONS)[number];

export function releaseFeedDayCount(value: unknown): ReleaseFeedDayCount {
  return RELEASE_FEED_DAY_OPTIONS.find((option) => option === Number(value)) ?? 10;
}

/** The feed page named by `page` in the location. */
export function releaseFeedPageFromSearch(search: string): number {
  const page = Number(new URLSearchParams(search).get("page"));
  return Number.isInteger(page) && page > 1 ? page : 1;
}

export type ReleaseFeedDay = {
  day: string;
  /** The day as a local calendar date, for formatting. */
  date: Date | null;
  /** Whole days before today: 0 is today, 1 yesterday; null when either day is unknown. */
  offset: number | null;
  families: ReleaseFeedFamily[];
};

function calendarDate(day: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/**
 * Groups a page's families by the day the server dated them, keeping their
 * order. `today` is the current day in the same zone.
 */
export function groupReleaseFeedByDay(families: ReleaseFeedFamily[], today: string): ReleaseFeedDay[] {
  const todayDate = calendarDate(today);
  const days: ReleaseFeedDay[] = [];
  for (const family of families) {
    let day = days[days.length - 1];
    if (!day || day.day !== family.day) {
      const date = calendarDate(family.day);
      const offset = date && todayDate ? Math.round((todayDate.getTime() - date.getTime()) / 86_400_000) : null;
      day = { day: family.day, date, offset, families: [] };
      days.push(day);
    }
    day.families.push(family);
  }
  return days;
}

/** The path of a subscribed circle, series, or voice actor page. */
export function subscriptionSubjectPath(subject: ReleaseFeedSubject | CreatorSubscription): string | null {
  if (subject.kind === "voice") return voiceDetailPath(subject.voiceRouteKey);
  if (!subject.circleId) return null;
  const circle = `/circles/${encodeURIComponent(subject.circleId)}`;
  if (subject.kind === "series" && subject.seriesId) return `${circle}/series/${encodeURIComponent(subject.seriesId)}`;
  return subject.kind === "circle" ? circle : null;
}

export function subscriptionSubjectName(subject: ReleaseFeedSubject | CreatorSubscription): string {
  switch (subject.kind) {
    case "voice":
      return subject.voiceName ?? "";
    case "series":
      return subject.seriesName || subject.seriesId || "";
    case "circle":
      return subject.circleName || subject.circleId || "";
    default:
      return "";
  }
}

export type SubscribeButtonState = "loading" | "unsubscribed" | "active" | "pending" | "covered" | "unavailable";

export function subscribeButtonState(lookup: CreatorSubscriptionLookup | null): SubscribeButtonState {
  if (!lookup) return "loading";
  if (lookup.subscription) return lookup.subscription.status === "active" ? "active" : "pending";
  if (lookup.coveredBy) return "covered";
  if (!lookup.available) return "unavailable";
  return "unsubscribed";
}

/**
 * What subscribing needs to confirm first: replacing series subscriptions of a
 * circle, and whether the catalog must be pulled for a baseline.
 */
export function subscribeConfirmation(lookup: CreatorSubscriptionLookup) {
  return {
    replacedSeries: lookup.series,
    needsBaseline: lookup.catalog.syncState !== "synced",
  };
}

/** The newest event names the family's place in the feed. */
export function primaryReleaseEvent(family: ReleaseFeedFamily): ReleaseFeedEvent | null {
  return family.events[0] ?? null;
}

/** One label per distinct subscription the family's events came through. */
export function releaseFeedSources(family: ReleaseFeedFamily, t: TFunction): string[] {
  const labels: string[] = [];
  for (const event of family.events) {
    const name = subscriptionSubjectName(event.subject);
    const label =
      event.subject.kind === "watch"
        ? t("subscriptions.feed.via.watch")
        : t(`subscriptions.feed.via.${event.subject.kind}`, { name });
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function editionLanguageName(language: string, t: TFunction) {
  const known = metadataTagLanguages.find(([code]) => code !== "" && code === language.trim().toLowerCase());
  return known ? t(known[1]) : language.toUpperCase();
}

export function releaseEventLabel(event: ReleaseFeedEvent, t: TFunction) {
  if (event.type === "edition" && event.language) {
    return t("subscriptions.feed.events.editionIn", { language: editionLanguageName(event.language, t) });
  }
  return t(`subscriptions.feed.events.${event.type}`);
}

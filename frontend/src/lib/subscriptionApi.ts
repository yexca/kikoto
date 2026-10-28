import { deleteJSON, getJSON, patchJSONBody, postJSON, postJSONBody, putJSONBody } from "@/lib/apiTransport";
import type { CatalogSyncState } from "@/lib/catalogSyncState";
import type { Work } from "@/lib/libraryApi";
import { deviceTimeZone } from "@/lib/timeZone";
import type { ShownWorksActionResult } from "@/lib/workflowApi";

export type CreatorSubscriptionKind = "circle" | "series" | "voice";

export type CreatorSubscription = {
  id: number;
  kind: CreatorSubscriptionKind;
  circleId?: string;
  circleName?: string;
  seriesId?: string;
  seriesName?: string;
  personId?: number;
  voiceRouteKey?: string;
  voiceName?: string;
  watchAvailability: boolean;
  /** Pending until the catalog has a baseline from a successful pull. */
  status: "active" | "pending";
  activatedAt: string | null;
  createdAt: string;
  catalogSyncedAt: string | null;
};

export type CreatorSubscriptionSchedule = {
  enabled: boolean;
  intervalHours: number;
  availabilityWatch: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  latestRun: { id: number; status: string } | null;
};

export type CreatorSubscriptionView = {
  subscriptions: CreatorSubscription[];
  schedule: CreatorSubscriptionSchedule;
  demo: boolean;
};

export type CreatorSubscriptionTarget =
  | { kind: "circle"; circleId: string }
  | { kind: "series"; circleId: string; seriesId: string }
  | { kind: "voice"; personId: number };

export type CreatorSubscriptionLookup = {
  subscription: CreatorSubscription | null;
  /** The circle subscription that already includes a series. */
  coveredBy: CreatorSubscription | null;
  /** This account's subscriptions to series of a circle. */
  series: CreatorSubscription[];
  catalog: { syncState: CatalogSyncState; lastSyncedAt: string | null };
  /** False when a voice actor catalog has no compatible remote source. */
  available: boolean;
};

export type CreatorSubscriptionRequest = CreatorSubscriptionTarget & {
  watchAvailability?: boolean;
  pullNow?: boolean;
  replaceSeries?: boolean;
};

export type CreatorSubscriptionCreated = {
  subscription: CreatorSubscription;
  removedSeries: CreatorSubscription[];
  pullRun: { runId: number; status: string } | null;
};

export type ReleaseFeedEventType = "released" | "edition" | "available";

export type ReleaseFeedSubject = {
  kind: CreatorSubscriptionKind | "watch";
  circleId?: string;
  circleName?: string;
  seriesId?: string;
  seriesName?: string;
  personId?: number;
  voiceRouteKey?: string;
  voiceName?: string;
};

export type ReleaseFeedEvent = {
  type: ReleaseFeedEventType;
  code: string;
  language: string;
  at: string;
  subject: ReleaseFeedSubject;
};

export type ReleaseFeedFallback = {
  code: string;
  title: string;
  coverUrl: string;
  releaseDate: string;
  circle: string;
  voiceActors: string[];
  tags: string[];
  dlsiteUrl: string;
};

export type ReleaseFeedFamily = {
  key: string;
  latestAt: string;
  /** The day, as YYYY-MM-DD in the account's time zone, of the newest event. */
  day: string;
  unread: boolean;
  /** Newest first. */
  events: ReleaseFeedEvent[];
  work: Work | null;
  fallback: ReleaseFeedFallback;
  /** Availability Watch watches the shown code or another edition of it; false for accounts that cannot see the pool. */
  watched: boolean;
  /** The available watch target behind a "Now available" event, for its Track and Fetch; null otherwise. */
  watchTarget: ReleaseFeedWatchTarget | null;
};

/** What a feed card needs to track or fetch an available watch target. */
export type ReleaseFeedWatchTarget = {
  id: number;
  workCode: string;
  availableCode: string;
  availableSourceId: number;
  trackRunStatus: string;
  fetchRunStatus: string;
  inLibrary: boolean;
};

export type ReleaseFeedPage = {
  families: ReleaseFeedFamily[];
  page: number;
  /** Days with entries per page, and how many the whole feed has. */
  days: number;
  totalDays: number;
  /** Families in the whole feed. */
  total: number;
  unreadCount: number;
  /** The current day in the zone the families are dated in. */
  today: string;
  demo: boolean;
};

function lookupQuery(target: CreatorSubscriptionTarget) {
  const query = new URLSearchParams({ kind: target.kind });
  if (target.kind === "voice") query.set("personId", String(target.personId));
  else query.set("circleId", target.circleId);
  if (target.kind === "series") query.set("seriesId", target.seriesId);
  return query.toString();
}

export const subscriptionApi = {
  listCreatorSubscriptions: (signal?: AbortSignal) => getJSON<CreatorSubscriptionView>("/api/subscriptions", signal),
  lookupCreatorSubscription: (target: CreatorSubscriptionTarget, signal?: AbortSignal) =>
    getJSON<CreatorSubscriptionLookup>(`/api/subscriptions/lookup?${lookupQuery(target)}`, signal),
  createCreatorSubscription: (request: CreatorSubscriptionRequest) =>
    postJSONBody<CreatorSubscriptionCreated>("/api/subscriptions", request),
  updateCreatorSubscription: (id: number, patch: { watchAvailability: boolean }) =>
    patchJSONBody<CreatorSubscription>(`/api/subscriptions/${id}`, patch),
  deleteCreatorSubscription: (id: number) => deleteJSON<{ ok: boolean }>(`/api/subscriptions/${id}`),
  updateCreatorSubscriptionSchedule: (
    patch: Partial<Pick<CreatorSubscriptionSchedule, "enabled" | "intervalHours" | "availabilityWatch">>,
  ) => putJSONBody<CreatorSubscriptionSchedule>("/api/subscriptions/schedule", patch),
  runCreatorSubscriptionRefresh: () => postJSON<{ runId: number; status: string }>("/api/subscriptions/refresh"),
  getReleaseFeed: (page: number, days: number, signal?: AbortSignal) => {
    const query = new URLSearchParams({ page: String(page), days: String(days) });
    const zone = deviceTimeZone();
    if (zone) query.set("timeZone", zone);
    return getJSON<ReleaseFeedPage>(`/api/subscriptions/feed?${query}`, signal);
  },
  getReleaseFeedUnread: (signal?: AbortSignal) => getJSON<{ count: number }>("/api/subscriptions/feed/unread", signal),
  markReleaseFeedSeen: () => postJSONBody<{ count: number }>("/api/subscriptions/feed/seen", {}),
  syncReleaseFeedMetadata: (page: number, days: number) =>
    postJSONBody<ShownWorksActionResult>("/api/subscriptions/feed/metadata-sync", { page, days }),
  checkReleaseFeedSources: (page: number, days: number) =>
    postJSONBody<ShownWorksActionResult>("/api/subscriptions/feed/source-check", { page, days }),
};

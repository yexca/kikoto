import { deleteJSON, getJSON, patchJSONBody, postJSONBody, putJSONBody } from "@/lib/apiTransport";
import type { Work } from "@/lib/libraryApi";
import { deviceTimeZone } from "@/lib/timeZone";

export type RankingProvider = "dlsite" | "remote_source";
export type RankingPeriod = "day" | "week" | "month" | "year" | "total";

/** `30d` limits a 24-hour, 7-day, or 30-day ranking to works released within 30 days. */
export type RankingReleaseWindow = "" | "30d";
/** `sale` orders a ranking by sales; empty is the popularity order. */
export type RankingSort = "" | "sale";

export type RankingOrder = { releaseWindow: RankingReleaseWindow; sort: RankingSort };

/** One order of a list, with its own snapshots, statistics, and seen state. */
export type RankingVariant = RankingOrder & {
  id: number;
  lastPulledAt: string | null;
  /** When the order last changed: the latest snapshot's time. */
  lastChangedAt: string | null;
  lastStatus: "" | "succeeded" | "failed" | "source_unavailable";
  /** The latest snapshot is newer than the one this account last looked at. */
  unseen: boolean;
};

export type RankingList = {
  id: number;
  provider: RankingProvider;
  sourceId: number | null;
  /** The remote source's display name; data, never styled per source. */
  sourceName: string;
  /** False while a remote list's source is disabled or incompatible; it is not pulled then. */
  sourceAvailable: boolean;
  /** Empty for a remote source list. */
  period: RankingPeriod | "";
  /** The ranking year (JST) of an annual list; 0 otherwise. */
  year: number;
  depth: number;
  /** Shown in Rankings and pulled. */
  enabled: boolean;
  autoRefresh: boolean;
  refreshIntervalMinutes: number;
  /** When the list is next pulled automatically, or null. */
  nextPullAt: string | null;
  /** A requested pull waits for its run. */
  pullRequested: boolean;
  /** An annual list's last pull after its year; it keeps no schedule. */
  finalAt: string | null;
  followCurrentYear: boolean;
  lastPulledAt: string | null;
  /** `partial` when some of the list's orders failed in its last pull. */
  lastStatus: "" | "succeeded" | "partial" | "failed" | "source_unavailable";
  /** The orders the list is pulled in, the default first. */
  variants: RankingVariant[];
};

export type RankingWorkflowCode = "dlsite_popular_collection" | "remote_popular_collection";

export type RankingWorkflowState = {
  code: RankingWorkflowCode;
  nextRunAt: string | null;
  latestRun: { id: number; status: string } | null;
};

export type RankingRetention = {
  fullDays: number;
  /** 0 keeps the daily history forever. */
  dailyDays: number;
};

export type RankingOverview = {
  lists: RankingList[];
  workflows: RankingWorkflowState[];
  retention: RankingRetention;
  /** The DLsite annual ranking year in progress (JST). */
  currentYear: number;
  /** The zone the account reads times and days in, as for New releases. */
  timeZone: string;
  timeZoneFollowsDevice: boolean;
  demo: boolean;
};

export type RankingSnapshotRef = { id: number; pulledAt: string; confirmedUntil: string };

export type RankingBaseline = RankingSnapshotRef & { kind: "seen" | "previous" | "snapshot" };

export type RankingCoverage = {
  /** `confirmed` when a pull returned the order at the time, `unpulled` when none ran since `confirmedUntil`, `before` before the history. */
  state: "confirmed" | "unpulled" | "before";
  confirmedUntil: string | null;
};

export type RankingChangeKind = "new" | "reentered" | "up" | "down" | "same";

export type RankingChange = {
  kind: RankingChangeKind;
  /** The rank in the baseline, when the code was in it. */
  from: number | null;
  /** Positive when the work moved up. */
  delta: number;
};

export type RankingFallback = {
  code: string;
  title: string;
  circle: string;
  coverUrl: string;
  dlsiteUrl: string;
};

export type RankingItem = {
  rank: number;
  code: string;
  change: RankingChange;
  firstSeenAt: string;
  streakStartedAt: string;
  bestRank: number;
  appearances: number;
  /** The library work with this code, or null when there is none. */
  work: Work | null;
  fallback: RankingFallback;
};

export type RankingDroppedItem = {
  code: string;
  previousRank: number;
  work: Work | null;
  fallback: RankingFallback;
};

export type RankingCounts = {
  new: number;
  reentered: number;
  up: number;
  down: number;
  dropped: number;
  notInLibrary: number;
};

export type RankingPage = {
  list: RankingList;
  /** The shown order of the list. */
  variant: RankingVariant;
  /** The requested time of a history page; null for the latest. */
  at: string | null;
  snapshot: RankingSnapshotRef | null;
  coverage: RankingCoverage | null;
  previousSnapshot: RankingSnapshotRef | null;
  nextSnapshot: RankingSnapshotRef | null;
  baseline: RankingBaseline | null;
  counts: RankingCounts;
  items: RankingItem[];
  dropped: RankingDroppedItem[];
  /** The first retained snapshot, and the time from which every changed snapshot is kept. */
  history: { firstPulledAt: string | null; fullFrom: string };
  demo: boolean;
};

export type RankingTimeline = {
  snapshots: RankingSnapshotRef[];
  nextAfterId: number | null;
  firstPulledAt: string | null;
  lastPulledAt: string | null;
  demo: boolean;
};

export type RankingListRequest = {
  provider: RankingProvider;
  sourceId?: number;
  period?: RankingPeriod;
  year?: number;
  depth?: number;
  autoRefresh?: boolean;
  refreshIntervalMinutes?: number;
};

export type RankingListPatch = Partial<
  Pick<RankingList, "enabled" | "autoRefresh" | "refreshIntervalMinutes" | "followCurrentYear" | "depth">
>;

export type RankingRefreshRun = { runId: number; status: string; workflowCode: RankingWorkflowCode };

function rankingOrderParams(order: Partial<RankingOrder>) {
  const params = new URLSearchParams();
  if (order.releaseWindow) params.set("release", order.releaseWindow);
  if (order.sort) params.set("sort", order.sort);
  return params;
}

export const rankingApi = {
  listRankings: (signal?: AbortSignal) => {
    const zone = deviceTimeZone();
    return getJSON<RankingOverview>(
      `/api/rankings${zone ? `?${new URLSearchParams({ timeZone: zone })}` : ""}`,
      signal,
    );
  },
  getRanking: (
    id: number,
    request: Partial<RankingOrder> & { at?: string; compare?: string },
    signal?: AbortSignal,
  ) => {
    const params = rankingOrderParams(request);
    if (request.at) params.set("at", request.at);
    if (request.compare) params.set("compare", request.compare);
    const query = params.size ? `?${params}` : "";
    return getJSON<RankingPage>(`/api/rankings/${id}${query}`, signal);
  },
  listRankingSnapshots: (
    id: number,
    range: Partial<RankingOrder> & { from?: string; to?: string; afterId?: number },
    signal?: AbortSignal,
  ) => {
    const params = rankingOrderParams(range);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (range.afterId) params.set("afterId", String(range.afterId));
    const query = params.size ? `?${params}` : "";
    return getJSON<RankingTimeline>(`/api/rankings/${id}/snapshots${query}`, signal);
  },
  markRankingSeen: (id: number, snapshotId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/rankings/${id}/seen`, { snapshotId }),
  createRanking: (request: RankingListRequest) =>
    postJSONBody<{ list: RankingList; runId: number }>("/api/rankings", request),
  updateRanking: (id: number, patch: RankingListPatch) => patchJSONBody<RankingList>(`/api/rankings/${id}`, patch),
  deleteRanking: (id: number) => deleteJSON<{ ok: boolean }>(`/api/rankings/${id}`),
  updateRankingRetention: (retention: RankingRetention) =>
    putJSONBody<RankingRetention>("/api/rankings/retention", retention),
  runRankingRefresh: (listIds?: number[]) =>
    postJSONBody<{ runs: RankingRefreshRun[] }>("/api/rankings/refresh", listIds?.length ? { listIds } : {}),
};

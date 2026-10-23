import { deleteJSON, getJSON, patchJSONBody, postJSONBody, putJSONBody } from "@/lib/apiTransport";
import type { Work } from "@/lib/libraryApi";

export type RankingProvider = "dlsite" | "remote_source";
export type RankingPeriod = "day" | "week" | "month";

export type RankingList = {
  id: number;
  provider: RankingProvider;
  sourceId: number | null;
  /** The remote source's display name; data, never styled per source. */
  sourceName: string;
  /** Empty for a remote source list. */
  period: RankingPeriod | "";
  releaseWindow: "" | "30d";
  depth: number;
  enabled: boolean;
  position: number;
  lastPulledAt: string | null;
  /** When the order last changed: the latest snapshot's time. */
  lastChangedAt: string | null;
  lastStatus: "" | "succeeded" | "failed" | "source_unavailable";
  /** The latest snapshot is newer than the one this account last looked at. */
  unseen: boolean;
};

export type RankingSchedule = {
  enabled: boolean;
  intervalHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string;
  latestRun: { id: number; status: string } | null;
};

export type RankingOverview = {
  lists: RankingList[];
  schedule: RankingSchedule;
  demo: boolean;
};

export type RankingSnapshotRef = { id: number; pulledAt: string };

export type RankingBaseline = RankingSnapshotRef & { kind: "seen" | "previous" | "snapshot" };

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
  snapshot: RankingSnapshotRef | null;
  baseline: RankingBaseline | null;
  counts: RankingCounts;
  items: RankingItem[];
  dropped: RankingDroppedItem[];
  /** Retained snapshots, newest first, for the comparison picker. */
  snapshots: RankingSnapshotRef[];
  demo: boolean;
};

export type RankingListRequest = {
  provider: RankingProvider;
  sourceId?: number;
  period?: RankingPeriod;
  releaseWindow?: "" | "30d";
  depth?: number;
};

export type RankingRefreshRun = { runId: number; status: string };

export const rankingApi = {
  listRankings: (signal?: AbortSignal) => getJSON<RankingOverview>("/api/rankings", signal),
  getRanking: (id: number, compare: string, signal?: AbortSignal) => {
    const query = compare ? `?${new URLSearchParams({ compare })}` : "";
    return getJSON<RankingPage>(`/api/rankings/${id}${query}`, signal);
  },
  markRankingSeen: (id: number, snapshotId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/rankings/${id}/seen`, { snapshotId }),
  createRanking: (request: RankingListRequest) =>
    postJSONBody<{ list: RankingList; runId: number }>("/api/rankings", request),
  updateRanking: (id: number, patch: Partial<Pick<RankingList, "enabled" | "depth" | "position">>) =>
    patchJSONBody<RankingList>(`/api/rankings/${id}`, patch),
  deleteRanking: (id: number) => deleteJSON<{ ok: boolean }>(`/api/rankings/${id}`),
  updateRankingSchedule: (patch: Partial<Pick<RankingSchedule, "enabled" | "intervalHours">>) =>
    putJSONBody<RankingSchedule>("/api/rankings/schedule", patch),
  runRankingRefresh: (listIds?: number[]) =>
    postJSONBody<RankingRefreshRun>("/api/rankings/refresh", listIds?.length ? { listIds } : {}),
};

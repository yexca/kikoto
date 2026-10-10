import { deleteJSON, getJSON, patchJSONBody, postJSONBody, sharedGetJSON } from "@/lib/apiTransport";
import type { MetadataIssueWork } from "@/lib/metadataApi";

export type Work = {
  id: number;
  primaryCode: string;
  title: string;
  ageRating: string;
  createdAt: string;
  updatedAt: string;
  releaseDate: string | null;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasLyrics?: boolean;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  series: string;
  seriesTitleId: string;
  trackCount: number;
  availableLocations: number;
  availability: string[];
  sourcePresence: SourcePresenceItem[] | null;
  progress: WorkProgressSummary;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  recommendScore: number;
};

export type RecommendationConfig = {
  affinityBase: number;
  unmarkedSlots: number;
  wantSlots: number;
  listeningSlots: number;
  finishedSlots: number;
  relistenSlots: number;
  shelvedSlots: number;
  tagWeight: number;
  tagCap: number;
  voiceWeight: number;
  voiceCap: number;
  circleWeight: number;
  circleCap: number;
  favoriteBonus: number;
  negativeMinEvidence: number;
  negativeTagWeight: number;
  negativeTagCap: number;
  negativeVoiceWeight: number;
  negativeVoiceCap: number;
  negativeCircleWeight: number;
  negativeCircleCap: number;
  negativeTotalCap: number;
  jitterAmplitude: number;
  explorationAmplitude: number;
};

export type RecommendationAffinityBreakdown = {
  scoreKind?: "affinity";
  algorithmVersion: string;
  lane: "unmarked" | "want" | "listening" | "finished" | "relisten" | "shelved";
  score: number;
  rawScore: number;
  ordering?: {
    seed: number;
    explorationBoost: number;
    jitter: number;
    diversityPenalty?: number;
    totalAdjustment: number;
    rankingScore: number;
  };
  signals: {
    listeningStatus: ListeningStatus;
    favorite: boolean;
    positiveTagMatches: number;
    positiveVoiceMatches: number;
    positiveCircleMatches: number;
    negativeTagMatches: number;
    negativeVoiceMatches: number;
    negativeCircleMatches: number;
  };
  components: Array<{
    key: string;
    label: string;
    matchCount: number;
    contribution: number;
    cap: number;
  }>;
};

export type DemoRecommendationBreakdown = {
  scoreKind: "demo_random";
  algorithmVersion: "demo-random-v1";
  score: number;
  rawScore: number;
  components: [];
};

export type RecommendationBreakdown = RecommendationAffinityBreakdown | DemoRecommendationBreakdown;

export type RecommendationEventInput = {
  workId?: number;
  eventType: "impression" | "open" | "play" | "positive_mark" | "paused_mark" | "reshuffle";
  contextId?: string;
  algorithmVersion?: string;
  seed?: number;
  rank?: number;
  score?: number;
};

export type RecommendationTelemetrySummary = {
  windowDays: number;
  totalEvents: number;
  eventCounts: Record<string, number>;
  scoreBuckets: Record<string, number>;
  generatedAt: string;
};

export type SourcePresenceItem = {
  type: string;
  availability: string;
  workId?: number;
  fileSourceId?: number;
  fileSourceCode?: string;
  fileSourceType?: string;
  fileSourceName?: string;
  remoteId?: string;
  remoteCode?: string;
  sourceUrl?: string;
  forked?: boolean;
};

export type WorkProgressSummary = {
  workId: number | null;
  mediaWorkId: number | null;
  mediaItemId: number | null;
  fileSourceId: number | null;
  locationId: number | null;
  locationType: string;
  title: string;
  positionSeconds: number;
  durationSeconds: number | null;
  lastPlayedAt: string | null;
  completed: boolean;
};

export type WorksPage = {
  works: Work[];
  page: number;
  pageSize: number;
  total: number;
  recommendationContext?: string;
  recommendationUnavailable?: boolean;
};

export type UnlinkedWorkMaintenanceSkip = {
  workId: number;
  code: string;
  reason: "not_found" | "source_available" | string;
};

export type UnlinkedWorkSourceCheckResult = {
  runId: number;
  jobId: number;
  status: string;
  queued: number;
  skipped: UnlinkedWorkMaintenanceSkip[];
};

export type UnlinkedWorkDeleteResult = {
  deletedFamilyCount: number;
  deletedWorkCount: number;
  deletedWorkIds: number[];
  deletedCodes: string[];
  retainedAssetFiles: number;
  skipped: UnlinkedWorkMaintenanceSkip[];
};

export type RecentlyPlayedWorksResponse = {
  works: Work[];
};

export type FavoriteWorksPage = WorksPage & {
  shelfTotal: number;
  listCounts: Record<string, number>;
  statusCounts: Record<string, number>;
};

export type LibrarySort = "recent" | "release" | "code" | "title" | "rating" | "sales" | "random" | "recommend";

export type FavoriteSort = "activity" | "added" | "release" | "code" | "title" | "rating" | "sales" | "random";

export type SortDirection = "asc" | "desc";

export type FavoriteList = {
  id: number;
  name: string;
  description: string;
  /** Presentation key for a user list's icon; empty or unknown keys use the default. */
  icon?: string;
  sortOrder: number;
  kind: "marked" | "user";
  selected?: boolean;
};

export type FavoriteListWorkIDs = {
  listId: number;
  workIds: number[];
};

/** How many of the requested works each of the user's own lists contains. */
export type FavoriteListMembershipSummary = {
  total: number;
  lists: { listId: number; count: number }[];
};

export type VoiceCredit = {
  personId: number;
  displayName: string;
};

export type ListeningStatus = "none" | "want_to_listen" | "listening" | "finished" | "relisten" | "paused";

export type LibrarySource = {
  id: number;
  code: string;
  displayName: string;
  sourceType: string;
  enabled: boolean;
  /** Absent from servers that predate this field; compatible remote types then keep their default capability. */
  metadataCapable?: boolean;
};

export type MaintenanceWork = Work & { noSource: boolean; metadataIssues: MetadataIssueWork[] };

export type MaintenanceWorkPage = Omit<WorksPage, "works"> & { works: MaintenanceWork[] };

export type UserTag = {
  id: number;
  name: string;
  color: string;
};

export type VoiceUserTag = UserTag;

/** Works, circles, and voices keep separate per-user tag vocabularies. */
export type UserTagScope = "work" | "circle" | "voice";

export type UserTagSuggestion = UserTag & { usageCount: number };

export const libraryApi = {
  getWorkRecommendation: (id: number, recommendationSession = "", seed?: number, recommendationContext = "") => {
    const params = new URLSearchParams();
    if (recommendationSession) params.set("recommendationSession", recommendationSession);
    if (seed !== undefined) params.set("seed", String(seed));
    if (recommendationContext) params.set("recommendationContext", recommendationContext);
    const query = params.toString();
    return getJSON<RecommendationBreakdown>(`/api/works/${id}/recommendation${query ? `?${query}` : ""}`);
  },
  recordRecommendationEvents: (events: RecommendationEventInput[]) =>
    postJSONBody<{ recorded: number }>("/api/recommendation-events", { events }),
  getRecommendationTelemetry: () => getJSON<RecommendationTelemetrySummary>("/api/recommendation-telemetry"),
  listWorksPage: (
    page = 1,
    pageSize = 24,
    query = "",
    scope = "all",
    status = "all",
    sort: LibrarySort = "recommend",
    direction: SortDirection = "desc",
    seed = 1,
    recommendBadges = false,
    signal?: AbortSignal,
    recommendationSession = "",
  ) =>
    getJSON<WorksPage>(
      `/api/works?page=${page}&pageSize=${pageSize}&scope=${encodeURIComponent(scope)}&status=${encodeURIComponent(status)}&sort=${encodeURIComponent(sort)}&direction=${encodeURIComponent(direction)}&seed=${seed}&recommendBadges=${recommendBadges}${recommendationSession ? `&recommendationSession=${encodeURIComponent(recommendationSession)}` : ""}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`,
      signal,
    ),
  checkUnlinkedWorkSources: (workIds: number[]) =>
    postJSONBody<UnlinkedWorkSourceCheckResult>("/api/maintenance/unlinked-works/source-check", { workIds }),
  deleteUnlinkedWorks: (workIds: number[], confirm: boolean) =>
    postJSONBody<UnlinkedWorkDeleteResult>("/api/maintenance/unlinked-works/delete", { workIds, confirm }),
  listFavoriteWorksPage: (
    page = 1,
    pageSize = 24,
    query = "",
    listId: number | "all" = "all",
    status = "all",
    availability = "all",
    sourceIDs: number[] = [],
    sort: FavoriteSort = "added",
    direction: SortDirection = "desc",
    seed = 1,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      listId: String(listId),
      status,
      availability,
      sort,
      direction,
      seed: String(seed),
    });
    for (const sourceID of sourceIDs) params.append("sourceId", String(sourceID));
    if (query.trim()) params.set("q", query.trim());
    return getJSON<FavoriteWorksPage>(`/api/favorite-works?${params.toString()}`, signal);
  },
  listLibrarySources: (signal?: AbortSignal) => getJSON<LibrarySource[]>("/api/library-sources", signal),
  listRecentlyPlayedWorks: (limit = 10, signal?: AbortSignal) =>
    getJSON<RecentlyPlayedWorksResponse>(`/api/recently-played-works?limit=${limit}`, signal),
  listFavoriteLists: (signal?: AbortSignal) => getJSON<FavoriteList[]>("/api/favorite-lists", signal),
  createFavoriteList: (payload: { name: string; description?: string; icon?: string }) =>
    postJSONBody<FavoriteList>("/api/favorite-lists", payload),
  updateFavoriteList: (
    id: number,
    payload: { name?: string; description?: string; icon?: string; sortOrder?: number },
  ) => patchJSONBody<FavoriteList>(`/api/favorite-lists/${id}`, payload),
  deleteFavoriteList: (id: number) => deleteJSON<{ ok: boolean; deleted: number }>(`/api/favorite-lists/${id}`),
  listFavoriteListWorkIDs: (id: number) => getJSON<FavoriteListWorkIDs>(`/api/favorite-lists/${id}/work-ids`),
  summarizeFavoriteListMembership: (workIds: number[]) =>
    postJSONBody<FavoriteListMembershipSummary>("/api/favorite-lists/membership/summary", { workIds }),
  /** Adds and removes works in one transaction; lists named in neither set keep their membership. */
  updateFavoriteListMembership: (payload: { workIds: number[]; addListIds: number[]; removeListIds: number[] }) =>
    postJSONBody<{ updated: number }>("/api/favorite-lists/membership", payload),
  listUserTags: (scope: UserTagScope, signal?: AbortSignal) =>
    sharedGetJSON<{ scope: UserTagScope; tags: UserTagSuggestion[] }>(`/api/tags?scope=${scope}`, signal),
  listMaintenanceWorks: (
    page: number,
    pageSize: number,
    query: string,
    reason: string,
    runId: number | null,
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q: query, reason });
    if (runId) params.set("runId", String(runId));
    return getJSON<MaintenanceWorkPage>(`/api/maintenance/works?${params}`, signal);
  },
};

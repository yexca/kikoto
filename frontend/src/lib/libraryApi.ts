import { deleteJSON, getJSON, patchJSONBody, postJSONBody, sharedGetJSON } from "@/lib/apiTransport";
import type { MetadataIssueWork } from "@/lib/metadataApi";

export type Work = {
  id: number;
  primaryCode: string;
  title: string;
  titleSource?: string;
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
  /** The viewer's own one-to-five-star rating; null or absent when unrated. */
  userRating?: number | null;
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
  /** Feedback weights, as percentages of one favorite work's evidence. */
  ratingFiveWeight: number;
  ratingFourWeight: number;
  ratingTwoWeight: number;
  ratingOneWeight: number;
  relistenWeight: number;
  shelvedWeight: number;
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
  /** Smart lists that have new works; absent from servers without smart lists. */
  newCounts?: Record<string, number>;
  /** Works of this page that are new in the requested smart list. */
  newWorkIds?: number[];
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
  kind: FavoriteListKind;
  selected?: boolean;
  /** A smart list that shows the work through its rule rather than a hand add. */
  matchedByRule?: boolean;
  /** Set on smart lists. */
  rule?: SmartListRuleView;
};

export type FavoriteListKind = "marked" | "user" | "smart";

export type SmartRuleTagKind = "metadata" | "user";

export type SmartRuleTag = { kind: SmartRuleTagKind; id: number };

/**
 * A smart list rule as it is saved: a work carries every required tag, at least
 * one tag of the any group when that group has tags, and no excluded tag.
 */
export type SmartListRule = {
  require: SmartRuleTag[];
  any: SmartRuleTag[];
  exclude: SmartRuleTag[];
};

/** A hidden or missing tag matches no work; a merged tag matches its target. */
export type SmartRuleTagState = "active" | "merged" | "hidden" | "missing";

export type SmartRuleTagView = SmartRuleTag & { resolvedId?: number; name: string; state: SmartRuleTagState };

export type SmartListRuleView = {
  require: SmartRuleTagView[];
  any: SmartRuleTagView[];
  exclude: SmartRuleTagView[];
};

export type SmartRuleTagOption = { id: number; name: string; workCount: number };

export type SmartRulePreview = { total: number; works: Work[] };

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
  /** The voice detail route key; empty for a credit that names no person. */
  routeKey: string;
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

export type MaintenanceWork = Work & {
  noSource: boolean;
  /** The family's best available source; local and remote are healthy, none needs attention. */
  sourceTier: "local" | "remote" | "none";
  metadataIssues: MetadataIssueWork[];
  /** DLsite was never asked about this catalog family. */
  metadataNotSynced: boolean;
  /** The never-synced family's sync is queued or running. */
  metadataSyncing: boolean;
  /** The remote source that filled a family without DLsite metadata; such a family is complete. */
  remoteMetadataSource?: string;
};

export type MaintenanceCounts = {
  catalog: number;
  all: number;
  metadata?: number;
  noSource?: number;
  custom: number;
};

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
    sort: FavoriteSort = "added",
    direction: SortDirection = "desc",
    seed = 1,
    signal?: AbortSignal,
    newOnly = false,
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
    if (query.trim()) params.set("q", query.trim());
    if (newOnly) params.set("new", "true");
    return getJSON<FavoriteWorksPage>(`/api/favorite-works?${params.toString()}`, signal);
  },
  listLibrarySources: (signal?: AbortSignal) => getJSON<LibrarySource[]>("/api/library-sources", signal),
  listRecentlyPlayedWorks: (limit = 10, signal?: AbortSignal) =>
    getJSON<RecentlyPlayedWorksResponse>(`/api/recently-played-works?limit=${limit}`, signal),
  listFavoriteLists: (signal?: AbortSignal) => getJSON<FavoriteList[]>("/api/favorite-lists", signal),
  createFavoriteList: (payload: {
    name: string;
    description?: string;
    icon?: string;
    kind?: "user" | "smart";
    rule?: SmartListRule;
  }) => postJSONBody<FavoriteList>("/api/favorite-lists", payload),
  updateFavoriteList: (
    id: number,
    payload: { name?: string; description?: string; icon?: string; sortOrder?: number; rule?: SmartListRule },
  ) => patchJSONBody<FavoriteList>(`/api/favorite-lists/${id}`, payload),
  /** Acknowledges every new work of a smart list. */
  markFavoriteListSeen: (id: number) =>
    postJSONBody<{ listId: number; newCount: number }>(`/api/favorite-lists/${id}/seen`, {}),
  /** Turns a smart list into a user list holding the works it shows now; they all become favorites. */
  convertFavoriteList: (id: number) => postJSONBody<FavoriteList>(`/api/favorite-lists/${id}/convert`, {}),
  previewSmartRule: (rule: SmartListRule, listId?: number, signal?: AbortSignal) =>
    postJSONBody<SmartRulePreview>("/api/favorite-lists/rule-preview", { rule, listId }, signal),
  listSmartRuleTags: (query: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ pageSize: "20" });
    if (query.trim()) params.set("q", query.trim());
    return getJSON<{ tags: SmartRuleTagOption[]; total: number }>(`/api/favorite-lists/rule-tags?${params}`, signal);
  },
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
  /** Family counts of the Metadata work views; a view the caller may not open is left out. */
  getMaintenanceCounts: (signal?: AbortSignal) => getJSON<MaintenanceCounts>("/api/maintenance/works/counts", signal),
};

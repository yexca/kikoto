// Typed builders for mocked API responses. Every builder returns a complete
// value of the frontend API type, so `npm run typecheck:e2e` reports a mock
// that drifts from `src/lib/api.ts`. Pass only the fields a test relies on.
import type {
  api,
  AppSettings,
  AppUpdate,
  AuthState,
  CircleCatalogWork,
  CircleDetail,
  CircleSourceStat,
  CircleSummary,
  CircleSummaryPage,
  CurrentUser,
  FavoriteList,
  FileSource,
  LibrarySource,
  MediaFileLocation,
  MediaItem,
  MetadataIssueWork,
  RecommendationConfig,
  RemoteTrack,
  RemoteWork,
  RemoteWorkDetail,
  RemoteWorksResponse,
  RuntimeSettings,
  SourceAvailabilitySource,
  VoiceCatalogRefreshState,
  VoiceDetail,
  VoiceKnownWork,
  VoiceSummary,
  VoiceSummaryPage,
  Work,
  WorkDetail,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunsPage,
  WorkProgressSummary,
  WorkResolveResponse,
  WorksPage,
  WorkTranslation,
} from "../../../src/lib/api";
import { syntheticWorkCode } from "../../../src/test-support/workCode";

/** The resolved body of an `api` client method, for endpoints without a named response type. */
export type ApiResponse<K extends keyof typeof api> = Awaited<ReturnType<(typeof api)[K]>>;

/** The error body the API client reads from a non-2xx response. */
export type ApiErrorBody = { error: string; code?: string; retryable?: boolean };

export const fixtureTimestamp = "2026-01-01T00:00:00Z";

export function workProgressFixture(overrides: Partial<WorkProgressSummary> = {}): WorkProgressSummary {
  return {
    workId: null,
    mediaWorkId: null,
    mediaItemId: null,
    fileSourceId: null,
    locationId: null,
    locationType: "",
    title: "",
    positionSeconds: 0,
    durationSeconds: null,
    lastPlayedAt: null,
    completed: false,
    ...overrides,
  };
}

export function workFixture(overrides: Partial<Work> = {}): Work {
  return {
    id: 1,
    primaryCode: syntheticWorkCode("RJ", 0),
    title: "Example Work",
    ageRating: "",
    createdAt: fixtureTimestamp,
    updatedAt: fixtureTimestamp,
    releaseDate: null,
    coverUrl: "",
    dlsiteUrl: "",
    circle: "",
    circleExternalId: "",
    rating: null,
    sales: null,
    regularPrice: null,
    price: null,
    priceCurrency: "",
    permanentlyFree: null,
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceCredits: [],
    series: "",
    seriesTitleId: "",
    trackCount: 0,
    availableLocations: 0,
    availability: [],
    sourcePresence: [],
    progress: workProgressFixture(),
    listeningStatus: "none",
    favorite: false,
    recommendScore: 0,
    ...overrides,
  };
}

export function worksPageFixture(works: Work[], overrides: Partial<WorksPage> = {}): WorksPage {
  return { works, page: 1, pageSize: 24, total: works.length, ...overrides };
}

/**
 * A work detail response. Shared fields come from `work`; detail-only fields
 * default to an empty, fully synced record without media.
 */
export function workDetailFixture(work: Work = workFixture(), overrides: Partial<WorkDetail> = {}): WorkDetail {
  return {
    id: work.id,
    primaryCode: work.primaryCode,
    baseCode: "",
    metadataLanguage: "JPN",
    workType: "audio",
    title: work.title,
    titleKana: "",
    description: "",
    releaseDate: work.releaseDate,
    ageRating: work.ageRating,
    durationSeconds: null,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    coverUrl: work.coverUrl,
    dlsiteUrl: work.dlsiteUrl,
    circle: work.circle,
    circleExternalId: work.circleExternalId,
    rating: work.rating,
    ratingCount: work.ratingCount ?? null,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    permanentlyFree: work.permanentlyFree,
    series: work.series,
    seriesTitleId: work.seriesTitleId,
    seriesCircleExternalId: "",
    dlsiteFetchedAt: "",
    tags: work.tags,
    userTags: work.userTags,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    listeningStatus: work.listeningStatus,
    favorite: work.favorite,
    metadataPresentation: { defaultVariantKey: "", variants: [] },
    metadataSync: { status: "available", checkedAt: "" },
    translations: [],
    manualOverrides: {},
    sourcePresence: work.sourcePresence,
    localFolders: [],
    mediaItems: [],
    ...overrides,
  };
}

export function workResolveFixture(work: Work, overrides: Partial<WorkResolveResponse> = {}): WorkResolveResponse {
  return {
    requestedCode: work.primaryCode,
    resolvedCode: work.primaryCode,
    workId: work.id,
    baseCode: "",
    isTranslation: false,
    title: work.title,
    coverUrl: work.coverUrl,
    circle: work.circle,
    circleExternalId: work.circleExternalId,
    releaseDate: work.releaseDate,
    rating: work.rating,
    sales: work.sales,
    regularPrice: work.regularPrice,
    price: work.price,
    priceCurrency: work.priceCurrency,
    permanentlyFree: work.permanentlyFree,
    tags: work.tags,
    voiceActors: work.voiceActors,
    voiceCredits: work.voiceCredits,
    ...overrides,
  };
}

export function metadataIssueWorkFixture(overrides: Partial<MetadataIssueWork> = {}): MetadataIssueWork {
  return {
    workId: 1,
    primaryCode: syntheticWorkCode("RJ", 0),
    title: "Example Work",
    providerCode: "dlsite",
    providerName: "DLsite",
    retrying: false,
    issues: [],
    ...overrides,
  };
}

export function workTranslationFixture(overrides: Partial<WorkTranslation> = {}): WorkTranslation {
  return {
    workId: null,
    primaryCode: syntheticWorkCode("RJ", 0),
    title: "Example Work",
    metadataLanguage: "JPN",
    editionLabel: "",
    origin: true,
    official: true,
    translationKind: "origin",
    current: true,
    hasMedia: false,
    mediaState: "metadata_only",
    localAvailable: false,
    ...overrides,
  };
}

export function mediaLocationFixture(overrides: Partial<MediaFileLocation> = {}): MediaFileLocation {
  return {
    id: 1,
    fileSourceId: 1,
    fileSourceCode: "local",
    fileSourceName: "Local",
    locationType: "local",
    path: "",
    streamUrl: "",
    downloadUrl: "",
    remoteHash: "",
    sizeBytes: null,
    durationSeconds: null,
    availability: "available",
    lastCheckedAt: null,
    ...overrides,
  };
}

export function mediaItemFixture(overrides: Partial<MediaItem> = {}): MediaItem {
  const id = overrides.id ?? 1;
  return {
    id,
    parentId: null,
    kind: "audio",
    title: "",
    discNo: null,
    trackNo: null,
    durationSeconds: null,
    sizeBytes: null,
    fingerprint: `fixture-${id}`,
    progress: null,
    locations: [],
    ...overrides,
  };
}

export function currentUserFixture(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 1,
    username: "listener",
    displayName: "Listener",
    uiLocale: "auto",
    role: "user",
    permissions: [],
    devMode: false,
    demoMode: false,
    passwordManagedBy: "account",
    ...overrides,
  };
}

export const anonymousAuthState: AuthState = { authenticated: false };

export function authenticatedStateFixture(user: Partial<CurrentUser> = {}): AuthState {
  return { authenticated: true, user: currentUserFixture(user) };
}

export function runtimeSettingsFixture(overrides: Partial<RuntimeSettings> = {}): RuntimeSettings {
  return {
    anonymousAccessEnabled: true,
    cacheEnabled: false,
    mode: "development",
    demoMode: false,
    directoryRoutingRules: [],
    recommendationThreshold: 50,
    ...overrides,
  };
}

export function recommendationConfigFixture(overrides: Partial<RecommendationConfig> = {}): RecommendationConfig {
  return {
    affinityBase: 35,
    unmarkedSlots: 12,
    wantSlots: 4,
    listeningSlots: 4,
    finishedSlots: 2,
    relistenSlots: 2,
    shelvedSlots: 0,
    tagWeight: 5,
    tagCap: 25,
    voiceWeight: 10,
    voiceCap: 20,
    circleWeight: 15,
    circleCap: 15,
    favoriteBonus: 10,
    negativeMinEvidence: 2,
    negativeTagWeight: 2,
    negativeTagCap: 6,
    negativeVoiceWeight: 3,
    negativeVoiceCap: 6,
    negativeCircleWeight: 5,
    negativeCircleCap: 5,
    negativeTotalCap: 15,
    jitterAmplitude: 3,
    explorationAmplitude: 18,
    ...overrides,
  };
}

export function appSettingsFixture(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    anonymousAccessEnabled: false,
    localScanDepth: 3,
    cacheEnabled: false,
    cacheLimitGb: 20,
    transcodeCacheLimitGb: 5,
    remoteDownloadLimitGb: 100,
    fetchStagingRetentionDays: 7,
    remoteSaveTemplate: "/data/<source_code>/<code_prefix>_<code_group>/<work_code>",
    remoteDelayBaseSeconds: 0.5,
    remoteDelayRandomSeconds: 1.5,
    remoteBackoffSeconds: 30,
    remoteMaxBackoffSeconds: 300,
    catalogFreshnessDays: 30,
    dlsiteMetadataLanguage: "ja-jp",
    dlsiteMetadataLanguages: ["ja-jp"],
    directoryRoutingRules: [],
    recommendationThreshold: 50,
    recommendationConfig: recommendationConfigFixture(),
    recommendationDefaults: recommendationConfigFixture(),
    dataRoot: "/data",
    cacheRoot: "/cache",
    fileSources: [],
    ...overrides,
  };
}

export function appUpdateFixture(version: string, overrides: Partial<AppUpdate> = {}): AppUpdate {
  return {
    currentVersion: version,
    latestVersion: version,
    updateAvailable: false,
    releaseUrl: "",
    checkedAt: fixtureTimestamp,
    ...overrides,
  };
}

export function favoriteListFixture(overrides: Partial<FavoriteList> = {}): FavoriteList {
  return { id: 1, name: "Marked", description: "", sortOrder: -1, kind: "marked", ...overrides };
}

export function librarySourceFixture(overrides: Partial<LibrarySource> = {}): LibrarySource {
  return {
    id: 1,
    code: "example_remote_a",
    displayName: "Example Remote A",
    sourceType: "kikoeru_compatible",
    enabled: true,
    ...overrides,
  };
}

export function fileSourceFixture(overrides: Partial<FileSource> = {}): FileSource {
  return {
    id: 1,
    code: "local",
    displayName: "Local",
    sourceType: "local_folder",
    priority: 0,
    enabled: true,
    config: {},
    endpoint: {
      baseUrl: "",
      apiUrl: "",
      fallbackUrl: "",
      workUrlTemplate: "",
      restrictOutboundHosts: false,
      allowedHostPatterns: [],
    },
    healthStatus: "healthy",
    lastCheckedAt: null,
    ...overrides,
  };
}

export function sourceAvailabilitySourceFixture(
  overrides: Partial<SourceAvailabilitySource> = {},
): SourceAvailabilitySource {
  return {
    sourceId: 1,
    sourceCode: "example_remote_a",
    displayName: "Example Remote A",
    status: "available",
    remoteId: "1",
    primaryCode: syntheticWorkCode("RJ", 0),
    title: "Example Work",
    coverUrl: "",
    workId: null,
    hasRemote: true,
    hasTracked: false,
    hasCache: false,
    hasLocal: false,
    error: "",
    elapsedMs: 1,
    ...overrides,
  };
}

export function remoteWorkFixture(overrides: Partial<RemoteWork> = {}): RemoteWork {
  const primaryCode = overrides.primaryCode ?? syntheticWorkCode("RJ", 0);
  return {
    remoteId: "1",
    primaryCode,
    remoteCode: primaryCode,
    title: "Example Work",
    releaseDate: "",
    updatedAt: "",
    coverUrl: "",
    circle: "",
    ageRating: "",
    rating: null,
    sales: null,
    price: null,
    tags: [],
    voiceActors: [],
    voiceRefs: [],
    importStatus: "remote_only",
    remotePlayable: true,
    workId: null,
    favorite: false,
    listeningStatus: "none",
    recommendScore: 0,
    ...overrides,
  };
}

export function remoteWorksResponseFixture(
  works: RemoteWork[],
  overrides: Partial<RemoteWorksResponse> = {},
): RemoteWorksResponse {
  return {
    sourceId: 1,
    works,
    page: 1,
    pageSize: 24,
    total: works.length,
    status: "ok",
    sort: "recent",
    direction: "desc",
    sortApplied: true,
    ...overrides,
  };
}

export function remoteTrackFixture(overrides: Partial<RemoteTrack> = {}): RemoteTrack {
  return {
    type: "audio",
    title: "track.mp3",
    hash: "hash",
    streamUrl: "",
    downloadUrl: "",
    durationSeconds: null,
    sizeBytes: null,
    cacheLocationId: null,
    cachePath: "",
    cacheAvailable: false,
    localLocationId: null,
    localPath: "",
    localAvailable: false,
    children: [],
    ...overrides,
  };
}

export function remoteWorkDetailFixture(overrides: Partial<RemoteWorkDetail> = {}): RemoteWorkDetail {
  const primaryCode = overrides.primaryCode ?? syntheticWorkCode("RJ", 0);
  return {
    sourceId: 1,
    sourceCode: "example_remote_a",
    sourceName: "Example Remote A",
    remoteId: "1",
    primaryCode,
    remoteCode: primaryCode,
    title: "Example Work",
    coverUrl: "",
    sourceUrl: "",
    publicWorkUrl: "",
    circle: "",
    rating: null,
    sales: null,
    price: null,
    ageRating: "",
    releaseDate: "",
    durationSeconds: null,
    tags: [],
    voiceActors: [],
    importStatus: "remote_only",
    workId: null,
    metadataPresentation: { defaultVariantKey: "", variants: [] },
    tracks: [],
    languageEditions: [],
    ...overrides,
  };
}

/** The tracks endpoint response for a remote work detail. */
export function remoteWorkTracksFixture(detail: RemoteWorkDetail): ApiResponse<"getRemoteSourceWorkTracks"> {
  return {
    sourceId: detail.sourceId,
    sourceCode: detail.sourceCode,
    sourceName: detail.sourceName,
    remoteId: detail.remoteId,
    primaryCode: detail.primaryCode,
    remoteCode: detail.remoteCode,
    tracks: detail.tracks,
  };
}

export function sourceStatFixture(overrides: Partial<CircleSourceStat> = {}): CircleSourceStat {
  return { key: "local", sourceId: null, displayName: "Local", status: "available", count: 1, ...overrides };
}

export function circleSummaryFixture(overrides: Partial<CircleSummary> = {}): CircleSummary {
  return {
    id: 1,
    externalId: "RG00000001",
    displayName: "Example Circle",
    aliases: [],
    rating: null,
    note: "",
    favorite: false,
    userTags: [],
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 0,
    missingWorks: 0,
    catalogWorks: 0,
    lastSyncedAt: null,
    syncState: "synced",
    syncReason: "",
    sourceSummaries: [],
    latestWork: null,
    ...overrides,
  };
}

export function circleSummaryPageFixture(
  circles: CircleSummary[],
  overrides: Partial<CircleSummaryPage> = {},
): CircleSummaryPage {
  return { circles, page: 1, pageSize: 24, total: circles.length, catalogWorks: 0, availableWorks: 0, ...overrides };
}

export function circleDetailFixture(
  circle: CircleSummary = circleSummaryFixture(),
  overrides: Partial<CircleDetail> = {},
): CircleDetail {
  return { ...circle, availableWorks: 0, works: [], series: [], ...overrides };
}

export function circleCatalogWorkFixture(overrides: Partial<CircleCatalogWork> = {}): CircleCatalogWork {
  const primaryCode = overrides.primaryCode ?? syntheticWorkCode("RJ", 0);
  return {
    workId: null,
    primaryCode,
    remoteCode: primaryCode,
    title: "Example Work",
    releaseDate: null,
    updatedAt: fixtureTimestamp,
    coverUrl: "",
    dlsiteUrl: "",
    circle: "Example Circle",
    circleExternalId: "RG00000001",
    ageRating: "",
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceRefs: [],
    voiceCredits: [],
    rating: null,
    sales: null,
    regularPrice: null,
    price: null,
    priceCurrency: "",
    permanentlyFree: null,
    series: "",
    seriesTitleId: "",
    catalogStatus: "",
    dlsiteAvailable: true,
    listeningMark: "none",
    favorite: false,
    local: false,
    remote: false,
    sourceTags: [],
    ...overrides,
  };
}

export function voiceSummaryFixture(overrides: Partial<VoiceSummary> = {}): VoiceSummary {
  return {
    personId: 1,
    displayName: "Example Voice",
    aliases: [],
    knownWorks: 0,
    localWorks: 0,
    remoteWorks: 0,
    cachedWorks: 0,
    playableWorks: 0,
    lastSeenAt: null,
    lastSyncedAt: null,
    syncState: "synced",
    syncReason: "",
    rating: null,
    note: "",
    favorite: false,
    userTags: [],
    sourceSummaries: [],
    latestWork: null,
    ...overrides,
  };
}

export function voiceSummaryPageFixture(
  voices: VoiceSummary[],
  overrides: Partial<VoiceSummaryPage> = {},
): VoiceSummaryPage {
  return { voices, page: 1, pageSize: 24, total: voices.length, tagOptions: [], ...overrides };
}

export function voiceDetailFixture(
  voice: VoiceSummary = voiceSummaryFixture(),
  overrides: Partial<VoiceDetail> = {},
): VoiceDetail {
  return { ...voice, aliasRecords: [], works: [], remoteMatches: [], ...overrides };
}

export function voiceKnownWorkFixture(overrides: Partial<VoiceKnownWork> = {}): VoiceKnownWork {
  const primaryCode = overrides.primaryCode ?? syntheticWorkCode("RJ", 0);
  return {
    workId: 1,
    primaryCode,
    remoteCode: primaryCode,
    title: "Example Work",
    releaseDate: null,
    updatedAt: fixtureTimestamp,
    coverUrl: "",
    dlsiteUrl: "",
    circle: "",
    circleExternalId: "",
    ageRating: "",
    rating: null,
    sales: null,
    regularPrice: null,
    price: null,
    priceCurrency: "",
    permanentlyFree: null,
    tags: [],
    userTags: [],
    voiceActors: [],
    voiceCredits: [],
    series: "",
    seriesTitleId: "",
    listeningMark: "none",
    favorite: false,
    local: false,
    remote: false,
    cache: false,
    sourceTags: [],
    progress: workProgressFixture(),
    ...overrides,
  };
}

export function voiceCatalogRefreshFixture(
  overrides: Partial<VoiceCatalogRefreshState> = {},
): VoiceCatalogRefreshState {
  return {
    status: "succeeded",
    reason: "",
    lastStatus: "succeeded",
    generation: 1,
    lastAttemptAt: "",
    lastSuccessAt: "",
    complete: true,
    pagesFetched: 1,
    catalogWorks: 0,
    metadataQueued: 0,
    queries: [],
    sources: [],
    error: "",
    ...overrides,
  };
}

export function workflowRunFixture(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    workflowCode: "local_scan",
    displayName: "Local scan",
    status: "succeeded",
    triggerType: "manual",
    triggerReason: "",
    createdAt: fixtureTimestamp,
    startedAt: fixtureTimestamp,
    finishedAt: fixtureTimestamp,
    summaryJson: "{}",
    nodeRunCount: 0,
    completedNodeRuns: 0,
    failedNodeRuns: 0,
    skippedNodeRuns: 0,
    jobCount: 0,
    completedJobs: 0,
    failedJobs: 0,
    skippedJobs: 0,
    progressBytesCurrent: 0,
    progressBytesTotal: 0,
    progressBytesUnknownItems: 0,
    candidateCount: 0,
    pendingCandidates: 0,
    acceptedCandidates: 0,
    rejectedCandidates: 0,
    reviewedAt: "",
    reviewedByUserId: null,
    definitionId: null,
    triggerId: null,
    ...overrides,
  };
}

export function workflowRunDetailFixture(
  run: WorkflowRun = workflowRunFixture(),
  overrides: Partial<WorkflowRunDetail> = {},
): WorkflowRunDetail {
  return { ...run, nodeRuns: [], graphJson: "{}", ...overrides };
}

export function workflowRunsPageFixture(
  runs: WorkflowRun[],
  overrides: Partial<WorkflowRunsPage> = {},
): WorkflowRunsPage {
  return {
    runs,
    page: 1,
    pageSize: 10,
    total: runs.length,
    viewTotals: { running: 0, review: 0, failed: 0, completed: 0 },
    ...overrides,
  };
}

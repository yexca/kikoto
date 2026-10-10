import { normalizeCatalogSyncState, type CatalogSyncState } from "@/lib/catalogSyncState";
import { combineAbortSignals, retryInvalidatedRequest, sharedInflightRequests } from "@/lib/inflightRequests";
import { apiMutationResources, apiReadResources } from "@/lib/apiRequestResources";
import { SITE_MAINTENANCE_EVENT } from "@/lib/appEvents";
import { DEMO_METADATA_LANGUAGES_HEADER, demoMetadataLanguagesHeaderValue } from "@/lib/demoMetadataLanguages";
import {
  apiSessionSignal,
  apiSessionVersion,
  assertApiSession,
  changeApiSession,
  observeApiPrincipal,
} from "@/lib/apiSession";

export type { CatalogSyncState } from "@/lib/catalogSyncState";

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
  hasAvailableNonOriginEdition?: boolean;
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

export type FileSourceDetectResult = {
  detected: boolean;
  sourceType: string;
  displayName: string;
  baseUrl: string;
  apiUrl: string;
  tried: string[];
};

export type DatabaseCleanupTaskKey =
  | "missing_folders"
  | "missing_files"
  | "empty_media_items"
  | "missing_presence"
  | "orphan_snapshots"
  | "unused_tags"
  | "expired_sessions"
  | "dismissed_notifications"
  | "old_runs"
  | "old_recommendation_events"
  | "stale_recommendation_generations";

export type DatabaseMaintenanceOverview = {
  scannedAt: string;
  databaseBytes: number;
  freeBytes: number;
  walBytes: number;
  dataRootAvailable: boolean;
  tasks: Array<{ key: DatabaseCleanupTaskKey; count: number; available: boolean }>;
};

export type DatabaseCleanupResult = {
  removed: number;
  results: Array<{ key: DatabaseCleanupTaskKey; removed: number; skipped: boolean }>;
};

/** Compaction runs as a workflow job; an active run is returned instead of a second one. */
export type DatabaseOptimizeResult = {
  runId: number;
  jobId: number;
  status: "queued" | "running";
  existing: boolean;
};

export type LibraryMode = "standard" | "pools";

export type LibraryPool = {
  /** First-level folder of the data directory; empty for the standard library. */
  path: string;
  online: boolean;
  reason?: string;
  canReconnect: boolean;
};

export type LibraryLayout = {
  mode: LibraryMode | "";
  configured: boolean;
  locked: boolean;
  onboardingCompleted: boolean;
  hasLegacyWorkflows: boolean;
  pools: LibraryPool[];
  candidates: string[];
  fetchPool: string;
  migrationScanRunId?: number;
  localScanTriggers: { startupScan: boolean; watchFolders: boolean };
};

export type LibraryLayoutUpdate = {
  mode: LibraryMode;
  pools?: string[];
  fetchPool?: string;
};

export type LibraryMigrationPreview = {
  hash: string;
  mode: LibraryMode;
  moveCount: number;
  bytes: number;
};

export type LibraryMigrationStatus = {
  status: "idle" | "running" | "failed" | "completed";
  phase?: string;
  progressCurrent?: number;
  progressTotal?: number;
  progressBytesCurrent?: number;
  progressBytesTotal?: number;
};

export type LegacyWorkflowMigrationItem = {
  id: number;
  name: string;
  reviewStatus: "pending" | "converted" | "skipped";
  preset?: string;
  inputs?: Record<string, unknown>;
  triggerCount: number;
  canConvert: boolean;
  reason?: string;
};

export type DatabaseBackupKind = "scheduled" | "manual" | "pre-migration";

export type DatabaseBackupFile = {
  name: string;
  kind: DatabaseBackupKind;
  sizeBytes: number;
  createdAt: string;
};

export type DatabaseBackupList = {
  available: boolean;
  backups: DatabaseBackupFile[];
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

export type MediaProgressUpdate = {
  workId: number;
  mediaWorkId: number;
  mediaItemId: number;
  fileSourceId: number | null;
  locationId: number | null;
  locationType: string;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  lastPlayedAt: string | null;
};

export type WorkPlaybackCursorResponse = {
  cursor: WorkProgressSummary | null;
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

export type WorkDetail = {
  titleChoices?: Record<string, WorkTitleChoice>;
  id: number;
  primaryCode: string;
  baseCode: string;
  metadataLanguage: string;
  workType: string;
  title: string;
  titleKana: string;
  description: string;
  releaseDate: string | null;
  ageRating: string;
  durationSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  series: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  dlsiteFetchedAt: string;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  listeningStatus: ListeningStatus;
  favorite: boolean;
  metadataPresentation: WorkMetadataPresentation;
  metadataSync: WorkMetadataSyncStatus;
  translations: WorkTranslation[];
  manualOverrides: WorkManualOverrides;
  metadataLink?: WorkMetadataLink | null;
  /** Set when this work is a purchase bonus with a link decision. */
  purchaseBonus?: WorkPurchaseBonus | null;
  /** Linked purchase bonuses whose parent belongs to this work's family. */
  purchaseBonuses?: WorkPurchaseBonusWork[] | null;
  sourcePresence: SourcePresenceItem[] | null;
  localFolders: WorkFolderLocation[];
  mediaItems: MediaItem[];
};

/** A user-declared DLsite product whose metadata is stored on this work. */
export type WorkMetadataLink = {
  sourceCode: string;
  url: string;
  updatedAt: string;
};

export type WorkMetadataLinkResult = {
  link: WorkMetadataLink | null;
  sync?: WorkMetadataSyncRunResult;
};

/**
 * The parent product a purchase bonus belongs to. The bonus stays its own work;
 * `parentWork` is set while the library has a work in the parent's family.
 */
export type WorkPurchaseBonus = {
  status: "linked" | "unmatched" | "dismissed";
  parentCode?: string;
  origin: "detected" | "user";
  evidence?: string;
  url?: string;
  parentWork?: WorkPurchaseBonusWork | null;
  updatedAt: string;
};

export type WorkPurchaseBonusWork = {
  id: number;
  code: string;
  title: string;
};

export type WorkPurchaseBonusResult = {
  purchaseBonus: WorkPurchaseBonus | null;
  sync?: WorkMetadataSyncRunResult;
};

export type WorkMetadataPresentation = {
  defaultVariantKey: string;
  variants: WorkMetadataVariant[];
};

export type WorkMetadataSyncStatus = {
  status: "not_synced" | "available" | "not_found" | "remote_fallback" | string;
  checkedAt: string;
  /** Remote source that filled a work DLsite reports as not found. */
  source?: string;
  /** Remote sources of normalized values while the work has no DLsite metadata. */
  fields?: WorkMetadataFieldSource[] | null;
};

export type WorkMetadataField = "title" | "release_date" | "age_rating" | "duration" | "circle" | "tags" | "cover";

export type WorkMetadataFieldSource = {
  field: WorkMetadataField | string;
  source: string;
};

export type WorkTitleChoice = {
  title: string;
  language: string;
  source: "manual" | "dlsite" | "original" | "remote";
  /** Remote source display name when source is "remote". */
  sourceName?: string;
  code: string;
  description: string;
};

export type WorkMetadataVariant = {
  description?: string;
  titleSource?: WorkTitleChoice["source"];
  key: string;
  language: string;
  title: string;
  tags: string[];
  origin: boolean;
};

export type WorkFolderLocation = {
  id: number;
  workId: number;
  fileSourceId: number;
  rootPath: string;
  role: string;
  state: "active" | "pending_cleanup" | "ignored" | string;
  primary: boolean;
};

export type ManualOverrideEntity = {
  name: string;
  externalId: string;
};

export type ManualOverrideSeries = {
  name: string;
  titleId: string;
  circleExternalId: string;
};

export type ManualOverridePerson = {
  name: string;
  personId: number;
};

export type ManualOverrideCover = {
  assetPath: string;
  originalPath: string;
  url: string;
};

export type WorkManualOverrides = {
  titles?: Record<string, string>;
  title?: string;
  circle?: ManualOverrideEntity;
  series?: ManualOverrideSeries;
  voiceActors?: ManualOverridePerson[];
  cover?: ManualOverrideCover;
};

export type WorkManualOverridePayload = {
  titles?: Record<string, string | null>;
  title?: string | null;
  circle?: ManualOverrideEntity | null;
  series?: ManualOverrideSeries | null;
  voiceActors?: ManualOverridePerson[];
};

export type MetadataTag = {
  pendingWorkCount: number;
  resolvedHidden: boolean;
  id: number;
  key: string;
  displayName: string;
  dlsiteGenreId: number | null;
  mergedIntoTagId: number | null;
  hidden: boolean;
  source: string;
  workCount: number;
  names: { language: string; name: string; source: string }[];
  mergedFromTagIds: number[];
};
export type MetadataTagOverride = { tagId: number; action: "add" | "remove" };
export type EffectiveMetadataTag = { id: number; displayName: string; source: string };
export type WorkMetadataTags = {
  tags: EffectiveMetadataTag[];
  inheritedTags: EffectiveMetadataTag[];
  overrides: MetadataTagOverride[];
};
export type MetadataCircle = {
  id: number;
  displayName: string;
  manualName: string;
  providerName: string;
  workCount: number;
  aliases: { id: number; alias: string; source: string }[];
  externalIds: string[];
  /** Primary DLsite maker id; empty for a circle known only from a remote source. */
  code: string;
  /** Latest known work's cover; present only in list results. */
  coverUrl?: string;
};
export type CircleMergeReview = {
  id: number;
  targetPartyId: number;
  sourcePartyId: number;
  targetName: string;
  sourceName: string;
  status: string;
  createdAt: string;
  undoneAt: string;
};
export type MetadataEntryPage<T> = { total: number; page: number; pageSize: number } & T;

export type WorkCoverCandidate = {
  locationId: number;
  fileName: string;
  path: string;
  previewUrl: string;
  sizeBytes: number | null;
  selected: boolean;
};

export type MetadataSuggestionResponse<T> = {
  items: T[];
  truncated: boolean;
};

export type CircleSuggestion = {
  partyId: number;
  name: string;
  externalId: string;
};

export type VoiceSuggestion = {
  personId: number;
  name: string;
};

export type SeriesSuggestion = {
  seriesId: number;
  name: string;
  titleId: string;
  circleExternalId: string;
  circleName: string;
};

export type WorkTranslation = {
  workId: number | null;
  primaryCode: string;
  title: string;
  metadataLanguage: string;
  editionLabel: string;
  origin: boolean;
  official: boolean;
  translationKind: "origin" | "official" | "community" | "third_party" | "unknown";
  current: boolean;
  hasMedia: boolean;
  mediaState: "metadata_only" | "present_unindexed" | "indexed_available" | "unavailable";
  localAvailable: boolean;
};

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

export type WorkResolveResponse = {
  requestedCode: string;
  resolvedCode: string;
  workId: number;
  baseCode: string;
  isTranslation: boolean;
  title: string;
  coverUrl: string;
  circle: string;
  circleExternalId: string;
  releaseDate: string | null;
  rating: number | null;
  sales: number | null;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  tags: string[];
  voiceActors: string[];
};

export type VoiceCredit = {
  personId: number;
  displayName: string;
};

export type WorkEntityLink = {
  kind: "circle" | "series" | "voice";
  route: string;
  resolved: boolean;
  fetched: boolean;
};

export type ListeningStatus = "none" | "want_to_listen" | "listening" | "finished" | "relisten" | "paused";

export type MediaItem = {
  id: number;
  parentId: number | null;
  kind: string;
  title: string;
  discNo: number | null;
  trackNo: number | null;
  durationSeconds: number | null;
  hasAudio?: boolean | null;
  sizeBytes: number | null;
  fingerprint: string;
  progress: MediaProgress | null;
  preferredLyricsMediaItemId?: number | null;
  /** The library-level lyrics file shared by every user unless they choose another. */
  assignedLyricsMediaItemId?: number | null;
  locations: MediaFileLocation[];
};

export type LyricsAssignmentChange = {
  audioMediaItemId: number;
  /** Null restores automatic name matching. */
  lyricsMediaItemId: number | null;
};

/** Downloads lyrics of a family edition from a remote source into a new folder of a local work folder. */
export type LyricsFetchRequest = {
  sourceId: number;
  remoteCode: string;
  folderId: number;
  /** Remote tree paths of the lyrics files to download. */
  files: string[];
  /** Downloaded files to assign as the library lyrics of local tracks. */
  assignments: { audioMediaItemId: number; path: string }[];
};

export type LyricsFetchResult = {
  workId: number;
  /** The new folder, relative to the library. */
  folder: string;
  downloaded: number;
  assigned: number;
};

export type MediaProgress = {
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
  lastPlayedAt: string | null;
};

export type MediaFileLocation = {
  id: number;
  fileSourceId: number;
  fileSourceCode: string;
  fileSourceName: string;
  locationType: string;
  path: string;
  streamUrl: string;
  downloadUrl: string;
  remoteHash: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  availability: string;
  lastCheckedAt: string | null;
};

export type FileSource = {
  id: number;
  code: string;
  displayName: string;
  sourceType: string;
  priority: number;
  enabled: boolean;
  config: {
    saveRootTemplate?: string;
    scanDepth?: number;
    /** Language a remote source is asked in last, after the viewer's metadata languages. */
    requestLanguage?: string;
    /** Declared capabilities; absent keeps the source type's default. */
    capabilities?: string[];
  };
  endpoint: {
    baseUrl: string;
    apiUrl: string;
    fallbackUrl: string;
    workUrlTemplate: string;
    restrictOutboundHosts: boolean;
    allowedHostPatterns: string[];
  };
  healthStatus: string;
  lastCheckedAt: string | null;
};

export type LibrarySource = {
  id: number;
  code: string;
  displayName: string;
  sourceType: string;
  enabled: boolean;
  /** Absent from servers that predate this field; compatible remote types then keep their default capability. */
  metadataCapable?: boolean;
};

export type UserPreferences = {
  directoryRoutingRules: DirectoryRoutingRule[];
  recommendationConfig: RecommendationConfig;
  recommendationThreshold: number;
  recommendationDefaults: RecommendationConfig;
  /** The user's own metadata language priority; null shows each work's original language. */
  metadataLanguages: string[] | null;
};

export type RuntimeSettings = {
  anonymousAccessEnabled: boolean;
  cacheEnabled: boolean;
  mode: "development" | "production" | "demo";
  demoMode: boolean;
  directoryRoutingRules: DirectoryRoutingRule[];
  recommendationThreshold: number;
};

export type AppUpdate = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  checkedAt: string;
};

export type AppSettings = {
  anonymousAccessEnabled: boolean;
  localScanDepth: number;
  /** Shallowest scan depth that still reaches every Fetch folder. */
  localScanDepthMinimum?: number;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  transcodeCacheLimitGb: number;
  remoteDownloadLimitGb: number;
  fetchStagingRetentionDays: number;
  remoteSaveTemplate: string;
  remoteDelayBaseSeconds: number;
  remoteDelayRandomSeconds: number;
  remoteBackoffSeconds: number;
  remoteMaxBackoffSeconds: number;
  catalogFreshnessDays: number;
  remoteMetadataFallback?: RemoteMetadataFallbackSettings;
  /** Metadata sync attaches a detected purchase bonus to its parent work's family. */
  purchaseBonusAutoLink?: boolean;
  proxy: ProxySettings;
  /** Lets every account enter a private or LAN address for a Kikoeru account import. */
  kikoeruImportPrivateAddresses: boolean;
  directoryRoutingRules: DirectoryRoutingRule[];
  recommendationThreshold: number;
  recommendationConfig: RecommendationConfig;
  recommendationDefaults: RecommendationConfig;
  dataRoot: string;
  cacheRoot: string;
  fileSources: FileSource[];
};

/** Opt-in lookup in selected remote sources, in order, when DLsite has no record. */
export type RemoteMetadataFallbackSettings = {
  enabled: boolean;
  sourceIds: number[];
};

export type ProxyScheme = "http" | "https" | "socks5" | "socks5h";

/** A forward proxy. Host is empty for a proxy on the machine that runs Kikoto. */
export type OutboundProxy = {
  id: string;
  name: string;
  kind: "host" | "custom";
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string;
  /** The server never returns a stored password. */
  hasPassword: boolean;
};

/** Enables proxies for a scope; empty proxyIds selects every proxy. */
export type ProxyRoute = { enabled: boolean; proxyIds: string[] };

export type SourceProxyRoute = { mode: "inherit" | "direct" | "proxy"; proxyIds: string[] };

export type ProxyRoutes = {
  dlsite: ProxyRoute;
  remote: ProxyRoute;
  other: ProxyRoute;
  /** Overrides keyed by remote file source id. */
  sources: Record<string, SourceProxyRoute>;
};

export type ProxySettings = {
  /** Where a local-machine proxy is reached from the server; not editable. */
  hostAddress: string;
  proxies: OutboundProxy[];
  routes: ProxyRoutes;
  /** Retry directly after every proxy of a route failed to connect. */
  directFallback: boolean;
};

/** Omitting password keeps the stored one for that id; an empty string clears it. */
export type ProxySettingsPayload = {
  proxies: Array<Omit<OutboundProxy, "hasPassword"> & { password?: string }>;
  routes: ProxyRoutes;
  directFallback: boolean;
};

export type DirectoryRoutingRule = {
  id: string;
  label: string;
  weight: number;
  aliases: string[];
  negativeAliases: string[];
  enabled: boolean;
};

export type RemoteWorksResponse = {
  sourceId: number;
  works: RemoteWork[];
  page: number;
  pageSize: number;
  total: number;
  status: string;
  error?: {
    code: "disabled" | "unavailable" | string;
    message: string;
    url?: string;
    retryable: boolean;
  };
  sort: LibrarySort;
  direction: SortDirection;
  sortApplied: boolean;
  recommendationUnavailable?: boolean;
};

export type RemoteWork = {
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string;
  updatedAt: string;
  coverUrl: string;
  circle: string;
  circleRef?: RemoteEntityRef;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasAvailableNonOriginEdition?: boolean;
  price: number | null;
  tags: string[];
  voiceActors: string[];
  voiceRefs: RemoteEntityRef[];
  importStatus: string;
  remotePlayable: boolean;
  workId: number | null;
  favorite: boolean;
  listeningStatus: ListeningStatus;
  recommendScore: number;
};

export type RemoteTrack = {
  type: string;
  title: string;
  hash: string;
  streamUrl: string;
  downloadUrl: string;
  durationSeconds: number | null;
  sizeBytes: number | null;
  cacheLocationId: number | null;
  cachePath: string;
  cacheAvailable: boolean;
  localLocationId: number | null;
  localPath: string;
  localAvailable: boolean;
  children: RemoteTrack[];
};

export type RemoteWorkDetail = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  title: string;
  coverUrl: string;
  sourceUrl: string;
  publicWorkUrl: string;
  circle: string;
  circleRef?: RemoteEntityRef;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  price: number | null;
  ageRating: string;
  releaseDate: string;
  durationSeconds: number | null;
  tags: string[];
  voiceActors: string[];
  importStatus: string;
  workId: number | null;
  metadataPresentation: WorkMetadataPresentation;
  tracks: RemoteTrack[];
  languageEditions: RemoteLanguageEdition[];
};

export type RemoteWorkMetadata = Omit<RemoteWorkDetail, "tracks">;

export type RemoteWorkTracksResponse = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  tracks: RemoteTrack[];
};

export type RemoteLanguageEdition = {
  remoteCode: string;
  language: string;
  label: string;
  displayOrder: number;
  current: boolean;
  origin: boolean;
};

export type SourceAvailabilitySource = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: "available" | "not_found" | "unavailable" | "disabled" | "error" | "unknown";
  remoteId: string;
  primaryCode: string;
  title: string;
  coverUrl: string;
  workId: number | null;
  hasRemote: boolean;
  hasTracked: boolean;
  hasCache: boolean;
  hasLocal: boolean;
  error: string;
  elapsedMs: number;
};

export type SourceAvailabilityResponse = {
  workCode: string;
  checkedAt: string;
  sources: SourceAvailabilitySource[];
};

export type RemoteWorkSyncResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  tracked: boolean;
  syncedMediaItems: number;
  syncedLocations: number;
  triggerReason: string;
};

export type RemoteWorkTrackResult = {
  runId: number;
  jobId: number;
  workId: number | null;
  primaryCode: string;
  status: string;
  triggerReason: string;
  deduplicated: boolean;
};

export type RemoteWorkSaveSummary = {
  total: number;
  skipExisting: number;
  cacheHit: number;
  cacheDownload: number;
  promote: number;
  conflict: number;
};

export type RemoteWorkSavePlanItem = {
  itemKey: string;
  path: string;
  kind: string;
  sizeBytes: number | null;
  sourceKind: string;
  action: string;
  status: string;
  sourcePath: string;
  localSourcePath: string;
  cachePath: string;
  targetPath: string;
  mediaItemId: number;
  localPaths: string[];
  targetExists: boolean;
  targetConflict: boolean;
  targetConflictReason: string;
  targetSizeBytes: number | null;
  originalTargetPath: string;
  resolution: RemoteFetchResolution;
  remoteSourceId: number;
  remoteSourceCode: string;
  remoteSourceName: string;
  remotePath: string;
  sourceOptions: RemoteFetchSourceOption[];
};

export type RemoteFetchResolution = "auto" | "keep_local" | "replace" | "keep_both" | "rename" | "exclude";

export type RemoteFetchFileDecision = {
  itemKey: string;
  sourceId: number;
  resolution: RemoteFetchResolution;
  targetPath: string;
};

export type RemoteFetchSourceOption = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  path: string;
  sizeBytes: number | null;
};

export type RemoteWorkSaveLocalFile = {
  mediaItemId: number;
  path: string;
  sizeBytes: number | null;
  available: boolean;
};

export type RemoteFetchRootReview = {
  rootPath: string;
  status: "not_applicable" | "ready" | "managed" | "legacy_managed" | "conflict";
  conflict: boolean;
  message: string;
};

export type RemoteWorkSavePlan = {
  sourceId: number;
  primaryCode: string;
  saveRoot: string;
  fetchRoot: RemoteFetchRootReview;
  localFiles: RemoteWorkSaveLocalFile[];
  items: RemoteWorkSavePlanItem[];
  summary: RemoteWorkSaveSummary;
  preparation: RemoteFetchPreparation;
};

export type RemoteFetchPreparation = {
  requestedCode: string;
  canonicalCode: string;
  metadataStatus: "complete" | "partial" | "degraded";
  warnings: string[];
  editions: RemoteFetchEdition[];
};

export type RemoteFetchEdition = {
  workId: number;
  primaryCode: string;
  title: string;
  metadataLanguage: string;
  editionLabel: string;
  translationKind: "origin" | "official" | "community" | "third_party" | "unknown";
  classificationSource: string;
  makerId: string;
  originMakerId: string;
  origin: boolean;
  localRoots: RemoteFetchLocalRoot[];
  sources: SourceAvailabilitySource[];
};

export type RemoteFetchLocalRoot = {
  id: number;
  fileSourceId: number;
  rootPath: string;
  role: "managed_fetch" | "external" | "alternate";
  state: "active" | "pending_cleanup" | "ignored";
  primary: boolean;
};

export type RemoteWorkSaveResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  saveRoot: string;
  savedFiles: number;
  skippedFiles: number;
  cachedFiles: number;
  promotedFiles: number;
  plan: RemoteWorkSaveSummary;
  requestId: string;
  deduplicated: boolean;
};

export type WorkSourceUntrackResult = {
  workId: number;
  sourceId: number;
  status: string;
  clearedCaches: number;
  deletedFiles: number;
  cachePaths: string[];
  trackedCleared: boolean;
  workPreserved: boolean;
  localPreserved: boolean;
};

export type WorkflowRun = {
  pendingMetadata?: number;
  id: number;
  workflowCode: string;
  displayName: string;
  status: string;
  triggerType: string;
  triggerReason: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  summaryJson: string;
  nodeRunCount: number;
  completedNodeRuns: number;
  failedNodeRuns: number;
  skippedNodeRuns: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  skippedJobs: number;
  progressBytesCurrent: number;
  progressBytesTotal: number;
  progressBytesUnknownItems: number;
  candidateCount: number;
  pendingCandidates: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  reviewedAt: string;
  reviewedByUserId: number | null;
  definitionId: number | null;
  triggerId: number | null;
  /** The work a Fetch run downloads; empty for other runs. */
  workCode?: string;
};

export type WorkflowRunsPage = {
  runs: WorkflowRun[];
  page: number;
  pageSize: number;
  total: number;
  viewTotals: {
    attention?: number;
    history?: number;
    running: number;
    review: number;
    failed: number;
    completed: number;
  };
};

export type WorkflowNodeRun = {
  id: number;
  nodeId: string;
  nodeType: string;
  displayName: string;
  position: number;
  status: string;
  inputJson: string;
  outputJson: string;
  errorMessage: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
};

export type WorkflowRunGraphPort = {
  id: string;
  dataType: string;
};

export type WorkflowRunGraphNode = {
  id: string;
  type: string;
  displayName: string;
  position: { x: number; y: number };
  inputs: WorkflowRunGraphPort[];
  outputs: WorkflowRunGraphPort[];
};

export type WorkflowRunGraphEdge = {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  dataType: string;
};

export type WorkflowRunGraph = {
  schemaVersion: 1;
  nodes: WorkflowRunGraphNode[];
  edges: WorkflowRunGraphEdge[];
};

export type WorkflowRunDetail = WorkflowRun & {
  metadataIssues?: { encountered: number; pending: number };
  nodeRuns: WorkflowNodeRun[];
  graphJson: string;
};

export type FetchFileState = "pending" | "active" | "done" | "failed" | "paused" | "stopped";

/** One planned file of a Fetch run; `path` is relative to the work folder. */
export type FetchFile = {
  path: string;
  kind: string;
  action: string;
  state: FetchFileState;
  sizeBytes: number | null;
  bytesCurrent: number;
};

export type MetadataIssueWork = {
  workId: number;
  primaryCode: string;
  title: string;
  providerCode: string;
  providerName: string;
  retrying: boolean;
  /** Remote source that filled a work DLsite does not have. */
  fallbackSource?: string;
  issues: {
    component: "metadata" | "cover";
    status: "failed" | "unavailable";
    failureCount: number;
    firstFailedAt: string;
    checkedAt: string;
  }[];
};

export type MetadataIssuePage = {
  items: MetadataIssueWork[];
  total: number;
  page: number;
  pageSize: number;
};

export type MaintenanceWork = Work & { noSource: boolean; metadataIssues: MetadataIssueWork[] };
export type MaintenanceWorkPage = Omit<WorksPage, "works"> & { works: MaintenanceWork[] };

export type WorkflowEvent = {
  id: number;
  runId: number;
  nodeRunId: number | null;
  jobId: number | null;
  level: string;
  eventType: string;
  message: string;
  detailJson: string;
  createdAt: string;
};

export type WorkflowRunEventStreamMessage =
  { type: "workflow"; event: WorkflowEvent } | { type: "tick"; status: string; lastEventId: number };

export type WorkflowCandidate = {
  id: number;
  runId: number;
  nodeRunId: number | null;
  type: string;
  externalKey: string;
  status: string;
  payloadJson: string;
  decisionJson: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunActionResult = {
  runId: number;
  status: string;
  message: string;
  newRunId?: number;
  recovered?: number;
  requeued?: number;
  failed?: number;
  active?: number;
};

export type LocalCandidateCleanupResult = {
  runId: number;
  candidateId: number;
  action: string;
  status: string;
  deleted: number;
  marked: number;
  failed: number;
  failures: string[];
};

export type WorkflowDefinition = {
  id: number;
  code: string;
  displayName: string;
  description: string;
  definitionJson: string;
  scope: "system" | "user";
  editable: boolean;
  ownerUserId: number | null;
  triggerCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowPresetParameter = {
  key: string;
  kind:
    | "circle_id"
    | "series_id"
    | "voice_person"
    | "source_ids"
    | "boolean"
    | "select"
    | "integer"
    | "date"
    | "text_template";
  /** Input selects and refreshes a catalog, filter narrows its works, action syncs and tags them. */
  group: "input" | "filter" | "action";
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  minimum?: number;
  maximum?: number;
  tokens?: string[];
};

/** Existing works a metadata sync covers; an omitted scope is every work with missing metadata. */
export type MetadataSyncOptions = {
  scope: "all" | "circle" | "voice" | "works";
  circleId?: string;
  personId?: number;
  mode: "missing" | "full";
  workCodes?: string[];
  sourceId?: number;
  remoteMetadataFallback?: RemoteMetadataFallbackSettings;
  purchaseBonusAutoLink?: boolean;
};

export type WorkflowPreset = {
  code: string;
  displayName: string;
  description: string;
  target: "circle" | "series" | "voice";
  defaultTagTemplate: string;
  parameters: WorkflowPresetParameter[];
};

export type WorkflowPresetRunResult = {
  runId: number;
  status: string;
  workflowCode: string;
  tagName: string;
  inputs: Record<string, unknown>;
};

export type AvailabilityWatchFamilyMember = {
  code: string;
  /** Empty for a provider-declared edition without its own work. */
  title: string;
  language: string;
  canonical: boolean;
};

export type AvailabilityWatchTarget = {
  id: number;
  workCode: string;
  title: string;
  /** The watched code's cover, or its family original's; empty when none is cached. */
  coverUrl: string;
  state: "monitoring" | "ready" | "action_queued" | "completed" | "error" | "disabled";
  nextCheckAt: string;
  lastCheckedAt: string;
  lastStatus: string;
  lastError: string;
  availableSourceId: number | null;
  /** The family edition the remote source offered. */
  availableCode: string;
  trackRunId: number | null;
  fetchRunId: number | null;
  /** Empty until the watch has fetched the code's family metadata. */
  family: AvailabilityWatchFamilyMember[];
};

export type AvailabilityWatch = {
  id: number;
  action: "monitor" | "track" | "fetch" | "track_fetch";
  sourceId: number | null;
  excludeExtensions: string[];
  revision: number;
  targets: AvailabilityWatchTarget[];
};

export type AvailabilityWatchRunResult = {
  runId: number;
  jobId: number;
  status: string;
  targetCount: number;
  checked: number;
  ready: number;
  dispatched: number;
  newlyAvailableCodes: string[];
  readyCodes: string[];
  failures: string[];
};

export type WorkflowTrigger = {
  id: number;
  workflowDefinitionId: number;
  workflowCode: string;
  displayName: string;
  triggerType: string;
  enabled: boolean;
  scheduleJson: string;
  configJson: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorMessage: string;
  createdAt: string;
  updatedAt: string;
};

export type CurrentUser = {
  id: number;
  username: string;
  displayName: string;
  uiLocale: "auto" | "en" | "zh-Hans" | "zh-Hant" | "ja" | "ko";
  role: "super_admin" | "admin" | "user";
  permissions: string[];
  devMode: boolean;
  demoMode: boolean;
  passwordManagedBy: "environment" | "account";
};

export type MetadataOnboarding = {
  status: string;
  missingWorks: number;
  runId: number;
};

export type WorkflowNotification = {
  id: number;
  workflowRunId: number;
  type: string;
  status: string;
  workId: number | null;
  fileSourceId: number | null;
  workCode: string;
  message: string;
  createdAt: string;
};

export type WorkflowNotificationsPage = {
  notifications: WorkflowNotification[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  clearableTotal: number;
};

export type RemoteTrackRunStatus = {
  runId: number;
  status: string;
  summaryJson: string;
};

export type FileSourceHealthCheckResult = {
  healthy: boolean;
  healthStatus: string;
  lastCheckedAt: string | null;
  elapsedMs: number;
};

export type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "admin" | "user";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The root account managed through the environment in environment mode. */
  environmentManaged?: boolean;
};

/** setupRequired marks a production instance that has no administrator yet. */
export type AuthState =
  { authenticated: false; setupRequired?: boolean } | { authenticated: true; user: CurrentUser; sessionToken?: string };

export type InitialSetupPayload = {
  setupToken: string;
  username: string;
  password: string;
};

export type AccessPolicy = {
  anonymousAccessEnabled: boolean;
};

export type HealthStatus = {
  status: string;
  version: string;
  minClientVersion?: string;
  minAndroidClientVersion?: string;
};

export type LocalMediaIndexMode = "incremental" | "full";

export type LocalMediaIndexResult = {
  runId: number;
  jobId: number;
  status: string;
  mode: LocalMediaIndexMode;
  existing: boolean;
};

export type SourcePresenceLibrary = "local" | "all";
export type SourcePresenceFilter = "all" | "no_remote_source";

export type SourcePresenceCheckOptions = {
  sourceId: number;
  library: SourcePresenceLibrary;
  filter: SourcePresenceFilter;
  limit: number;
};

export type SourcePresenceCheckResult = {
  runId: number;
  jobId: number;
  status: string;
  existing: boolean;
};

export type LocalScanResult = {
  runId: number;
  jobId: number;
  fileSourceId: number;
  status: string;
  detectedWorks: number;
  scannedFiles: number;
  updatedLocations: number;
  skippedLocations: number;
  followUpRun: boolean;
  newWorkCodes: string[];
  failures: string[];
};

export type LocalMediaRefreshResult = {
  workId: number;
  fileSourceId: number;
  status: string;
  indexedFiles: number;
};

export type DLsiteSyncResult = {
  runId: number;
  jobId: number;
  status: string;
  targetWorks: number;
  syncedWorks: number;
  failedWorks: number;
  failures: string[];
};

export type WorkMetadataSyncRunResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  deduplicated: boolean;
};

export type RemoteCollectionRunResult = {
  runId: number;
  sourceId: number;
  collectionKind: string;
  action: "track" | "fetch";
  status: string;
  discovered: number;
  accepted: number;
  skipped: number;
  tracked: number;
  fetched: number;
  tagged: number;
  failed: number;
  childRuns: number[];
  failures: string[];
  expectedMaximum: number;
  returnedCount: number;
  tagName: string;
};

export type DLsitePopularRunResult = {
  runId: number;
  status: string;
  period: "day" | "week" | "month" | "year";
  releaseWindow: "30d" | "";
  year: number;
  tagName: string;
  discovered: number;
  synced: number;
  tagged: number;
  failed: number;
  failures: string[];
};

export type CircleSourceStat = {
  key: string;
  sourceId?: number | null;
  displayName: string;
  status: string;
  count: number;
};

export type CreatorLatestWork = {
  primaryCode: string;
  title: string;
  releaseDate: string | null;
  coverUrl: string;
};

export type CreatorListOptions = {
  page?: number;
  pageSize?: number;
  query?: string;
  filter?: string;
  tag?: string;
  /** "id" orders by Kikoto id; omitted keeps the browse order. */
  sort?: "id";
  signal?: AbortSignal;
};

export type CircleSummary = {
  id: number;
  externalId: string;
  displayName: string;
  aliases: string[];
  rating: number | null;
  note: string;
  favorite: boolean;
  userTags: VoiceUserTag[];
  localWorks: number;
  playableWorks: number;
  remoteWorks: number;
  missingWorks: number;
  catalogWorks: number;
  lastSyncedAt: string | null;
  syncState: CatalogSyncState;
  syncReason: string;
  sourceSummaries: CircleSourceStat[];
  latestWork: CreatorLatestWork | null;
};

function normalizeCreatorSyncState<T extends { syncState?: unknown }>(creator: T): T & { syncState: CatalogSyncState } {
  return { ...creator, syncState: normalizeCatalogSyncState(creator.syncState) };
}

export type CircleSummaryPage = {
  circles: CircleSummary[];
  page: number;
  pageSize: number;
  total: number;
  catalogWorks: number;
  availableWorks: number;
};

export type CircleCatalogWork = {
  workId: number | null;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string | null;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  ageRating: string;
  tags: string[];
  userTags: UserTag[];
  voiceActors: string[];
  voiceCredits: VoiceCredit[];
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasAvailableNonOriginEdition?: boolean;
  regularPrice: number | null;
  price: number | null;
  priceCurrency: string;
  permanentlyFree: boolean | null;
  series: string;
  seriesTitleId: string;
  catalogStatus: string;
  dlsiteAvailable: boolean;
  listeningMark: string;
  favorite: boolean;
  local: boolean;
  remote: boolean;
  sourceTags: CircleSourceStat[];
  progress?: WorkProgressSummary;
};

export type RemoteEntityRef = {
  sourceId: number;
  externalId: string;
  name: string;
};

export type CircleSeries = {
  titleId: string;
  name: string;
  url: string;
  declaredWorks: number;
  works: number;
  localWorks: number;
  remoteWorks: number;
  missingWorks: number;
  workCodes: string[];
};

export type CircleDetail = CircleSummary & {
  availableWorks: number;
  works: CircleCatalogWork[];
  series: CircleSeries[];
  /** Newest follow run for this circle, so the page can follow a queued refresh across reloads. */
  refresh?: CreatorRefreshRun | null;
};

export type VoiceSummary = {
  personId: number;
  displayName: string;
  aliases: string[];
  knownWorks: number;
  localWorks: number;
  remoteWorks: number;
  cachedWorks: number;
  playableWorks: number;
  lastSeenAt: string | null;
  lastSyncedAt: string | null;
  syncState: CatalogSyncState;
  syncReason: string;
  rating: number | null;
  note: string;
  favorite: boolean;
  userTags: VoiceUserTag[];
  sourceSummaries: CircleSourceStat[];
  latestWork: CreatorLatestWork | null;
};

export type VoiceSummaryPage = {
  voices: VoiceSummary[];
  page: number;
  pageSize: number;
  total: number;
  tagOptions: string[];
};

export type UserTag = {
  id: number;
  name: string;
  color: string;
};

export type VoiceUserTag = UserTag;

/** Works, circles, and voices keep separate per-user tag vocabularies. */
export type UserTagScope = "work" | "circle" | "voice";

export type UserTagSuggestion = UserTag & { usageCount: number };

export type VoiceAlias = {
  id: number;
  alias: string;
  source: string;
  createdAt: string;
};

export type VoiceAliasCandidate = {
  personId: number;
  displayName: string;
  aliases: VoiceAlias[];
  knownWorks: number;
  localWorks: number;
  remoteWorks: number;
};

export type VoiceMergeReview = {
  id: number;
  targetPersonId: number;
  sourcePersonId: number;
  targetName: string;
  sourceName: string;
  status: string;
  createdAt: string;
  undoneAt: string;
};

export type VoiceRemoteObservation = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteCode: string;
  status: SourceAvailabilitySource["status"];
};

export type VoiceKnownWork = {
  workId: number;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string | null;
  updatedAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  circleExternalId: string;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasAvailableNonOriginEdition?: boolean;
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
  listeningMark: ListeningStatus;
  favorite: boolean;
  local: boolean;
  remote: boolean;
  cache: boolean;
  sourceTags: CircleSourceStat[];
  remoteObservations?: VoiceRemoteObservation[];
  progress: WorkProgressSummary;
};

export type VoiceRemoteWork = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string;
  updatedAt: string;
  coverUrl: string;
  circle: string;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasAvailableNonOriginEdition?: boolean;
  price: number | null;
  tags: string[];
  voiceActors: string[];
  importStatus: string;
  remotePlayable: boolean;
  workId: number | null;
  hasLocal: boolean;
  hasCache: boolean;
  hasRemote: boolean;
  availability?: string;
};

export type VoiceRemoteSourceSet = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: string;
  error: string;
  debugError?: string;
  elapsedMs: number;
  total: number;
  works: VoiceRemoteWork[];
};

export type VoiceCatalogSourceStatus = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: string;
  error: string;
  pages: number;
  total: number;
  matches: number;
  elapsedMs: number;
};

/**
 * A circle or voice actor detail refresh. It queues the creator's follow
 * workflow without a tag. A circle refresh syncs metadata for catalog works
 * that lack it; a voice actor refresh keeps to known works.
 */
export type CreatorRefreshRequest = {
  catalogRefresh: "stored" | "incremental" | "full";
  metadataRefresh: "off" | "missing" | "all";
  /** Circles only: also match the circle's works on every compatible remote source. */
  sourceCheck?: boolean;
};

export type CreatorRefreshRun = {
  runId: number;
  status: string;
  /** True when an identical refresh was already queued or running. */
  deduplicated?: boolean;
};

export type VoiceCatalogRefreshState = {
  status: string;
  reason: string;
  lastStatus: string;
  generation: number;
  runId?: number;
  lastAttemptAt: string;
  lastSuccessAt: string;
  complete: boolean;
  pagesFetched: number;
  catalogWorks: number;
  metadataQueued: number;
  queries: string[];
  sources: VoiceCatalogSourceStatus[];
  error: string;
};

export type VoiceDetail = VoiceSummary & {
  aliasRecords: VoiceAlias[];
  works: VoiceKnownWork[];
  remoteMatches: VoiceRemoteSourceSet[];
  /** Known works without a provider snapshot; Retry metadata targets exactly these. */
  metadataMissingWorks?: number;
};

export type MediaTextPreview = {
  path: string;
  content: string;
};

export type MediaCacheResult = {
  runId: number;
  jobId: number;
  locationId: number;
  cachePath: string;
  status: string;
  alreadyDone: boolean;
};

export type CacheWorkOverview = {
  groupKey: string;
  workId: number;
  workCode: string;
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  files: number;
  bytes: number;
  referencedFiles: number;
  referencedBytes: number;
  orphanFiles: number;
  orphanBytes: number;
  emptyDirectories: number;
  tracked: boolean;
  local: boolean;
};

export type CacheOverview = {
  scannedAt: string;
  mediaFiles: number;
  mediaBytes: number;
  referencedFiles: number;
  referencedBytes: number;
  orphanFiles: number;
  orphanBytes: number;
  protectedFiles: number;
  missingReferences: number;
  emptyDirectories: number;
  works: CacheWorkOverview[];
  transcode: TranscodeCacheOverview;
};

export type TranscodeCacheOverview = {
  files: number;
  bytes: number;
  limitBytes: number;
  scannedAt: string;
};

export type TranscodeCacheClearResult = {
  deletedFiles: number;
  freedBytes: number;
};

export type VideoPlaybackInfo = {
  delivery: "direct" | "hls";
  url: string;
  durationSeconds: number;
  seekable: boolean;
};

export type CacheMaintenanceResult = {
  runId: number;
  jobId: number;
  status: "queued" | "running" | "succeeded" | "failed";
  queued: number;
};

export type MediaCleanupTarget = {
  kind: "cache" | "local" | "local_root";
  locationId: number;
  folderId?: number;
  expectedPath?: string;
};

export type MediaCleanupMode = "files_only" | "files_and_forget_work";

export type MediaCleanupResult = {
  runId: number;
  jobId: number;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  queued: number;
};

const BUILD_API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

export function API_BASE() {
  if (isNativeApp()) return getStoredServerURL();
  return BUILD_API_BASE;
}

function apiURL(path: string, base = API_BASE()) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function creatorListSearch(options: CreatorListOptions) {
  const search = new URLSearchParams();
  if (options.page) search.set("page", String(options.page));
  if (options.pageSize) search.set("pageSize", String(options.pageSize));
  if (options.query?.trim()) search.set("q", options.query.trim());
  if (options.filter && options.filter !== "all") search.set("filter", options.filter);
  if (options.tag?.trim()) search.set("tag", options.tag.trim());
  if (options.sort) search.set("sort", options.sort);
  const value = search.toString();
  return value ? `?${value}` : "";
}

export function assetURL(path: string) {
  if (!path) return "";
  return nativeAssetURL(apiURL(path), API_BASE());
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;

  constructor(message: string, status: number, code = "", retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function responseError(response: Response, fallback: string) {
  try {
    assertResponseCurrent(response);
    const payload = await response.json().catch(() => ({ error: fallback, code: "", retryable: false }));
    assertResponseCurrent(response);
    const message = payload.error ?? fallback;
    recordApiError({
      method: "HTTP",
      path: response.url || fallback,
      status: response.status,
      message,
    });
    if (payload.code === "site_maintenance") globalThis.dispatchEvent?.(new Event(SITE_MAINTENANCE_EVENT));
    return new ApiError(message, response.status, payload.code ?? "", payload.retryable === true);
  } finally {
    responseContexts.get(response)?.complete();
  }
}

export function mediaDownloadURL(locationId: number) {
  return assetURL(`/api/media/${locationId}/download`);
}

async function requestJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const version = apiSessionVersion();
  try {
    const response = await fetchAPI(path, init);
    if (!response.ok) {
      throw await responseError(response, `${init.method ?? "GET"} ${path} failed with ${response.status}`);
    }
    return await readApiJSON<T>(response);
  } finally {
    assertApiSession(version);
    init.signal?.throwIfAborted();
  }
}

function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(path, { signal });
}

const responseContexts = new WeakMap<Response, { version: number; signal: AbortSignal; complete: () => void }>();

function assertResponseCurrent(response: Response) {
  const context = responseContexts.get(response);
  if (!context) return;
  assertApiSession(context.version);
  context.signal.throwIfAborted();
}

async function readApiJSON<T>(response: Response): Promise<T> {
  try {
    assertResponseCurrent(response);
    return (await response.json()) as T;
  } finally {
    // A session or caller can change while the response body is being read,
    // including when decoding fails. Neither old results nor old errors escape.
    try {
      assertResponseCurrent(response);
    } finally {
      responseContexts.get(response)?.complete();
    }
  }
}

// Concurrent callers of the same idempotent GET share one request. A caller's
// abort only detaches that caller; a settled request is never reused.
async function sharedGetJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const version = apiSessionVersion();
  const key = JSON.stringify([version, API_BASE(), path, demoMetadataLanguagesHeaderValue()]);
  const cancellation = combineAbortSignals(apiSessionSignal(), signal);
  const current = cancellation.signal;
  try {
    return await retryInvalidatedRequest(
      () => sharedInflightRequests.run(key, (shared) => getJSON<T>(path, shared), current, apiReadResources(path)),
      current,
    );
  } finally {
    try {
      assertApiSession(version);
      current.throwIfAborted();
    } finally {
      cancellation.dispose();
    }
  }
}

async function streamWorkflowRunEvents(
  id: number,
  afterId: number,
  signal: AbortSignal,
  onMessage: (message: WorkflowRunEventStreamMessage) => void,
) {
  const query = afterId > 0 ? `?afterId=${encodeURIComponent(String(afterId))}` : "";
  const path = `/api/workflow-runs/${id}/events/stream${query}`;
  const response = await fetchAPI(path, {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    throw await responseError(response, `GET ${path} failed with ${response.status}`);
  }
  if (!response.body) throw new Error("Workflow event stream is unavailable.");

  assertResponseCurrent(response);
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  const current = responseContexts.get(response)!.signal;
  current.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let eventID = "";
  let dataLines: string[] = [];
  let terminal = false;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    assertResponseCurrent(response);
    const data = dataLines.join("\n");
    const payload: unknown = JSON.parse(data);
    if (eventName === "workflow" && typeof payload === "object" && payload !== null && "id" in payload) {
      onMessage({ type: "workflow", event: payload as WorkflowEvent });
    } else if (eventName === "tick" && typeof payload === "object" && payload !== null) {
      const tick = payload as { status?: unknown; lastEventId?: unknown };
      const message: WorkflowRunEventStreamMessage = {
        type: "tick",
        status: typeof tick.status === "string" ? tick.status : "",
        lastEventId: typeof tick.lastEventId === "number" ? tick.lastEventId : Number(eventID) || 0,
      };
      onMessage(message);
      const status = message.status.trim().toLowerCase();
      terminal = status !== "" && status !== "queued" && status !== "running";
    }
    eventName = "";
    eventID = "";
    dataLines = [];
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") eventName = value;
    if (field === "id") eventID = value;
    if (field === "data") dataLines.push(value);
  };

  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      assertResponseCurrent(response);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (terminal) break;
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer) consumeLine(buffer);
      dispatch();
    }
  } catch (error) {
    assertResponseCurrent(response);
    throw error;
  } finally {
    current.removeEventListener("abort", cancel);
    reader.releaseLock();
    responseContexts.get(response)?.complete();
  }
  if (terminal) return;
  throw new Error("Workflow event stream closed.");
}

function postJSON<T>(path: string): Promise<T> {
  return requestJSON<T>(path, { method: "POST" });
}

async function postJSONBody<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return requestJSON<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function patchJSONBody<T>(path: string, body: unknown): Promise<T> {
  return requestJSON<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putJSONBody<T>(path: string, body: unknown): Promise<T> {
  return requestJSON<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteJSON<T>(path: string): Promise<T> {
  return requestJSON<T>(path, { method: "DELETE" });
}

// A write that may outlive the page (a pagehide flush) opts into keepalive.
async function sendJSONBody<T>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  init: Pick<RequestInit, "signal" | "keepalive"> = {},
): Promise<T> {
  return requestJSON<T>(path, {
    ...init,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A multipart upload; the browser sets the boundary, so no content type is forced. */
async function sendFormData<T>(path: string, body: FormData, init: Pick<RequestInit, "signal"> = {}): Promise<T> {
  return requestJSON<T>(path, { ...init, method: "POST", body });
}

/**
 * The authenticated JSON transport for focused feature API modules. It carries
 * the same browser cookie or native bearer credentials and error mapping as `api`.
 */
export const apiTransport = {
  getJSON,
  sendJSONBody,
  sendFormData,
  deleteJSON,
};

function requestInit(init: RequestInit = {}, authenticate = true): RequestInit {
  const headers = new Headers(init.headers);
  const demoMetadataLanguages = demoMetadataLanguagesHeaderValue();
  if (authenticate && demoMetadataLanguages) headers.set(DEMO_METADATA_LANGUAGES_HEADER, demoMetadataLanguages);
  if (isNativeApp()) {
    headers.set("X-Kikoto-Mobile", "1");
    if (authenticate) {
      const token = getStoredSessionToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return {
    ...init,
    credentials: !authenticate || isNativeApp() ? "omit" : "include",
    headers,
  };
}

async function fetchAPI(path: string, init: RequestInit = {}, baseURL?: string, authenticate = true) {
  const url = apiURL(path, baseURL);
  const method = (init.method ?? "GET").toUpperCase();
  const version = apiSessionVersion();
  const cancellation = combineAbortSignals(apiSessionSignal(), init.signal);
  const signal = cancellation.signal;
  const resources = method !== "GET" && method !== "HEAD" ? apiMutationResources(path) : null;
  let settleWrite = () => {};
  const settled = new Promise<void>((resolve) => {
    settleWrite = resolve;
  });
  const invalidateResources = () => {
    if (!resources) return;
    if (resources.forget === null) sharedInflightRequests.forgetAll();
    else sharedInflightRequests.forgetResources(resources.forget);
    sharedInflightRequests.invalidateResources(resources.interrupt, settled);
  };
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    cancellation.dispose();
    // The body can still be loading after headers arrive. Fence reads from
    // the whole mutation, including a failed decode or HTTP error response.
    if (version === apiSessionVersion()) invalidateResources();
    settleWrite();
  };
  let returnedResponse = false;
  signal.throwIfAborted();
  invalidateResources();
  try {
    const response = await fetch(url, requestInit({ ...init, signal }, authenticate));
    assertApiSession(version);
    signal.throwIfAborted();
    responseContexts.set(response, { version, signal, complete });
    returnedResponse = true;
    return response;
  } catch (error) {
    assertApiSession(version);
    signal.throwIfAborted();
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    recordApiError({
      method: init.method ?? "GET",
      path: url,
      message: error instanceof Error ? error.message : "Network request failed.",
    });
    throw error;
  } finally {
    // JSON/error decoding completes successful transports. Network failures
    // complete here. Old writes never affect reads in a newer session.
    if (!returnedResponse) complete();
  }
}

async function login(username: string, password: string) {
  changeApiSession();
  const version = apiSessionVersion();
  const state = await postJSONBody<AuthState>("/api/auth/login", { username, password });
  assertApiSession(version);
  if (state.authenticated && state.sessionToken) {
    const syncing = setStoredSessionToken(state.sessionToken);
    const syncingVersion = apiSessionVersion();
    try {
      await syncing;
    } finally {
      assertApiSession(syncingVersion);
    }
  }
  changeApiSession();
  observeApiPrincipal(state.authenticated ? state.user.id : null);
  return state;
}

async function completeInitialSetup(payload: InitialSetupPayload) {
  changeApiSession();
  const version = apiSessionVersion();
  const state = await postJSONBody<AuthState>("/api/auth/setup", payload);
  assertApiSession(version);
  if (state.authenticated && state.sessionToken) {
    const syncing = setStoredSessionToken(state.sessionToken);
    const syncingVersion = apiSessionVersion();
    try {
      await syncing;
    } finally {
      assertApiSession(syncingVersion);
    }
  }
  changeApiSession();
  observeApiPrincipal(state.authenticated ? state.user.id : null);
  return state;
}

async function logout() {
  changeApiSession();
  const version = apiSessionVersion();
  try {
    return await postJSON<{ ok: boolean }>("/api/auth/logout");
  } finally {
    assertApiSession(version);
    const clearing = isNativeApp() ? clearStoredSessionToken() : Promise.resolve();
    const clearedVersion = apiSessionVersion();
    try {
      await clearing;
    } finally {
      assertApiSession(clearedVersion);
      changeApiSession();
    }
  }
}

const DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export const api = {
  appUpdate: () => getJSON<AppUpdate>("/api/app-update"),
  health: async (baseURL?: string, signal?: AbortSignal) => {
    const response = await fetchAPI("/health", { redirect: "error", signal }, baseURL, false);
    if (!response.ok) {
      throw await responseError(response, `GET /health failed with ${response.status}`);
    }
    return readApiJSON<HealthStatus>(response);
  },
  me: async () => {
    const version = apiSessionVersion();
    const state = await getJSON<AuthState>("/api/auth/me");
    assertApiSession(version);
    observeApiPrincipal(state.authenticated ? state.user.id : null);
    return state;
  },
  updateCurrentAccount: (payload: {
    displayName?: string;
    uiLocale?: CurrentUser["uiLocale"];
    currentPassword?: string;
    newPassword?: string;
  }) => patchJSONBody<AuthState>("/api/auth/me", payload),
  login,
  completeInitialSetup,
  logout,
  listNotifications: (page = 1, pageSize = 50) =>
    getJSON<WorkflowNotificationsPage>(`/api/notifications?page=${page}&pageSize=${pageSize}`),
  dismissNotification: (id: number) => deleteJSON<{ ok: boolean }>(`/api/notifications/${id}`),
  clearSucceededNotifications: () => postJSON<{ ok: boolean; dismissed: number }>("/api/notifications/clear-succeeded"),
  getRemoteTrackRunStatus: (id: number) => getJSON<RemoteTrackRunStatus>(`/api/remote-track-runs/${id}`),
  listUsers: () => getJSON<ManagedUser[]>("/api/users"),
  createUser: (payload: {
    username: string;
    displayName: string;
    role: ManagedUser["role"];
    password: string;
    enabled: boolean;
  }) => postJSONBody<ManagedUser>("/api/users", payload),
  updateUser: (
    id: number,
    payload: { displayName?: string; role?: ManagedUser["role"]; password?: string; enabled?: boolean },
  ) => patchJSONBody<ManagedUser>(`/api/users/${id}`, payload),
  deleteUser: (id: number) => deleteJSON<{ ok: boolean }>(`/api/users/${id}`),
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
  getWorkPlaybackCursor: (id: number, signal?: AbortSignal) =>
    getJSON<WorkPlaybackCursorResponse>(`/api/works/${id}/playback-cursor`, signal),
  getUserPreferences: (signal?: AbortSignal) => getJSON<UserPreferences>("/api/auth/me/preferences", signal),
  updateUserPreferences: (payload: Partial<Omit<UserPreferences, "recommendationDefaults">>) =>
    patchJSONBody<UserPreferences>("/api/auth/me/preferences", payload),
  getRuntimeSettings: (signal?: AbortSignal): Promise<RuntimeSettings> =>
    sharedGetJSON("/api/runtime-settings", signal),
  listRemoteSourceWorks: (
    id: number,
    page = 1,
    pageSize = 24,
    query = "",
    sort: LibrarySort = "recent",
    direction: SortDirection = "desc",
    seed = 1,
    recommendBadges = false,
    signal?: AbortSignal,
    recommendationSession = "",
  ) =>
    getJSON<RemoteWorksResponse>(
      `/api/remote-sources/${id}/works?page=${page}&pageSize=${pageSize}&sort=${encodeURIComponent(sort)}&direction=${encodeURIComponent(direction)}&seed=${seed}&recommendBadges=${recommendBadges}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}${recommendationSession ? `&recommendationSession=${encodeURIComponent(recommendationSession)}` : ""}`,
      signal,
    ),
  scoreRemoteRecommendations: (
    id: number,
    payload: {
      recommendationSession: string;
      works: Array<Pick<RemoteWork, "primaryCode" | "workId" | "tags" | "voiceActors" | "circle">>;
    },
    signal?: AbortSignal,
  ) =>
    postJSONBody<{ scores: Array<{ primaryCode: string; score: number }> }>(
      `/api/remote-sources/${id}/recommendations`,
      payload,
      signal,
    ),
  getRemoteSourceWorkMetadata: (id: number, code: string, signal?: AbortSignal) =>
    getJSON<RemoteWorkMetadata>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}`, signal),
  getRemoteSourceWorkTracks: (id: number, code: string, signal?: AbortSignal) =>
    getJSON<RemoteWorkTracksResponse>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/tracks`, signal),
  getRemoteSourceWork: async (id: number, code: string, signal?: AbortSignal) => {
    const version = apiSessionVersion();
    const metadata = await getJSON<RemoteWorkMetadata>(
      `/api/remote-sources/${id}/works/${encodeURIComponent(code)}`,
      signal,
    );
    assertApiSession(version);
    const tracks = await getJSON<RemoteWorkTracksResponse>(
      `/api/remote-sources/${id}/works/${encodeURIComponent(metadata.remoteCode || code)}/tracks`,
      signal,
    );
    assertApiSession(version);
    return { ...metadata, tracks: tracks.tracks };
  },
  getSourceAvailability: (code: string) =>
    getJSON<SourceAvailabilityResponse>(`/api/works/${encodeURIComponent(code)}/source-availability`),
  checkSourceAvailability: (code: string, sourceId = 0) =>
    postJSONBody<SourceAvailabilityResponse>(`/api/works/${encodeURIComponent(code)}/source-availability`, {
      sourceId,
    }),
  planRemoteSourceWorkSave: (
    id: number,
    code: string,
    paths: string[],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSavePlan>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch-plan`, {
      paths,
      minFreeBytes,
    }),
  saveRemoteSourceWork: (
    id: number,
    code: string,
    paths: string[],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSaveResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch`, {
      paths,
      minFreeBytes,
    }),
  planRemoteSourceWorkFetch: (
    id: number,
    code: string,
    paths: string[],
    localPaths: string[] = [],
    targetRoot = "",
    decisions: RemoteFetchFileDecision[] = [],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSavePlan>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch-plan`, {
      paths,
      localPaths,
      targetRoot,
      decisions,
      minFreeBytes,
    }),
  fetchRemoteSourceWork: (
    id: number,
    code: string,
    paths: string[],
    localPaths: string[] = [],
    requestId = "",
    targetRoot = "",
    decisions: RemoteFetchFileDecision[] = [],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSaveResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch`, {
      paths,
      localPaths,
      requestId,
      targetRoot,
      decisions,
      minFreeBytes,
    }),
  trackRemoteSourceWork: (id: number, code: string, triggerReason: string) =>
    postJSONBody<RemoteWorkTrackResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/track`, {
      triggerReason,
    }),
  syncRemoteSourceWork: (id: number, code: string, triggerReason: string) =>
    postJSONBody<RemoteWorkSyncResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/sync`, {
      triggerReason,
    }),
  untrackWorkSource: (workId: number, sourceId: number) =>
    deleteJSON<WorkSourceUntrackResult>(`/api/works/${workId}/tracked-sources/${sourceId}`),
  // Components that mount together often ask for the same work; they share one
  // in-flight request, and nothing is cached once it settles.
  getWork: (id: number, signal?: AbortSignal) => sharedGetJSON<WorkDetail>(`/api/works/${id}`, signal),
  getWorkSummary: (id: number | string, signal?: AbortSignal) =>
    getJSON<WorkDetail>(`/api/works/${encodeURIComponent(id)}?includeMedia=false`, signal),
  getWorkMedia: (id: number | string, signal?: AbortSignal) =>
    getJSON<{ workId: number; mediaWorkId: number; mediaItems: MediaItem[] }>(
      `/api/works/${encodeURIComponent(id)}/media`,
      signal,
    ),
  refreshWorkLocalFiles: (id: number, fileSourceId?: number | null) =>
    postJSONBody<LocalMediaRefreshResult>(`/api/works/${id}/local-files/refresh`, { fileSourceId: fileSourceId ?? 0 }),
  listMetadataTags: ({
    query = "",
    page = 1,
    pageSize = 25,
    includeHidden = false,
    resolveMerged = false,
    sort = "name",
    signal,
  }: {
    query?: string;
    page?: number;
    pageSize?: number;
    includeHidden?: boolean;
    resolveMerged?: boolean;
    /** "id" orders by tag id, independent of any language; "name" by display name. */
    sort?: "name" | "id";
    signal?: AbortSignal;
  } = {}) =>
    getJSON<MetadataEntryPage<{ tags: MetadataTag[]; pendingWorkCount?: number }>>(
      `/api/metadata/tags?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}&includeHidden=${includeHidden}&resolveMerged=${resolveMerged}&sort=${sort}`,
      signal,
    ),
  createMetadataTag: (name: string) => postJSONBody<MetadataTag>("/api/metadata/tags", { name }),
  getMetadataTag: (id: number, signal?: AbortSignal) => getJSON<MetadataTag>(`/api/metadata/tags/${id}`, signal),
  updateMetadataTag: (id: number, payload: { names?: Record<string, string>; hidden?: boolean }) =>
    patchJSONBody<MetadataTag>(`/api/metadata/tags/${id}`, payload),
  mergeMetadataTag: (id: number, targetTagId: number) =>
    postJSONBody<MetadataTag>(`/api/metadata/tags/${id}/merge`, { targetTagId }),
  undoMetadataTagMerge: (id: number) => deleteJSON<MetadataTag>(`/api/metadata/tags/${id}/merge`),
  getWorkMetadataTags: (id: number, signal?: AbortSignal) =>
    getJSON<WorkMetadataTags>(`/api/works/${id}/metadata-tags`, signal),
  /** `newTagNames` holds language names for tags this save creates, keyed by the trimmed new tag name. */
  setWorkMetadataTags: (
    id: number,
    overrides: MetadataTagOverride[],
    newTags: string[] = [],
    newTagNames: Record<string, Record<string, string>> = {},
  ) =>
    putJSONBody<WorkMetadataTags>(`/api/works/${id}/metadata-tags`, {
      overrides,
      ...(newTags.length ? { newTags } : {}),
      ...(Object.keys(newTagNames).length ? { newTagNames } : {}),
    }),
  listMetadataCircles: ({
    query = "",
    page = 1,
    pageSize = 25,
    signal,
  }: { query?: string; page?: number; pageSize?: number; signal?: AbortSignal } = {}) =>
    getJSON<MetadataEntryPage<{ circles: MetadataCircle[] }>>(
      `/api/metadata/circles?q=${encodeURIComponent(query)}&page=${page}&pageSize=${pageSize}`,
      signal,
    ),
  getMetadataCircle: (id: number) => getJSON<MetadataCircle>(`/api/metadata/circles/${id}`),
  renameMetadataCircle: (id: number, manualName: string) =>
    patchJSONBody<MetadataCircle>(`/api/metadata/circles/${id}`, { manualName }),
  addCircleAlias: (id: number, alias: string) =>
    postJSONBody<MetadataCircle>(`/api/metadata/circles/${id}/aliases`, { alias }),
  deleteCircleAlias: (id: number, aliasId: number) =>
    deleteJSON<MetadataCircle>(`/api/metadata/circles/${id}/aliases/${aliasId}`),
  mergeMetadataCircle: (id: number, sourcePartyId: number) =>
    postJSONBody<{ ok: boolean; mergeId: number }>(`/api/metadata/circles/${id}/merge`, { sourcePartyId }),
  listCircleMerges: (id: number) => getJSON<CircleMergeReview[]>(`/api/metadata/circles/${id}/merges`),
  undoCircleMerge: (id: number, mergeId: number) =>
    postJSONBody<{ ok: boolean }>(`/api/metadata/circles/${id}/merges/${mergeId}/undo`, {}),
  getWorkManualOverrides: (id: number) => getJSON<WorkManualOverrides>(`/api/works/${id}/manual-overrides`),
  updateWorkManualOverrides: (id: number, payload: WorkManualOverridePayload) =>
    patchJSONBody<WorkManualOverrides>(`/api/works/${id}/manual-overrides`, payload),
  deleteWorkManualOverride: (id: number, field: string, language?: string) =>
    deleteJSON<{ ok: boolean; deleted: number }>(
      `/api/works/${id}/manual-overrides/${encodeURIComponent(field)}${language === undefined ? "" : `?language=${encodeURIComponent(language)}`}`,
    ),
  setWorkMetadataLink: (id: number, sourceCode: string) =>
    putJSONBody<WorkMetadataLinkResult>(`/api/works/${id}/metadata-link`, { sourceCode }),
  deleteWorkMetadataLink: (id: number) => deleteJSON<WorkMetadataLinkResult>(`/api/works/${id}/metadata-link`),
  setWorkPurchaseBonus: (id: number, parentCode: string) =>
    putJSONBody<WorkPurchaseBonusResult>(`/api/works/${id}/purchase-bonus`, { parentCode }),
  deleteWorkPurchaseBonus: (id: number) => deleteJSON<WorkPurchaseBonusResult>(`/api/works/${id}/purchase-bonus`),
  listWorkCoverCandidates: (id: number) =>
    getJSON<{ candidates: WorkCoverCandidate[]; providerCoverUrl: string }>(`/api/works/${id}/cover-candidates`),
  setWorkCoverOverride: (id: number, locationId: number) =>
    postJSONBody<WorkManualOverrides>(`/api/works/${id}/cover-override`, { locationId }),
  suggestCircles: (query: string, limit = 20) =>
    getJSON<MetadataSuggestionResponse<CircleSuggestion>>(
      `/api/metadata-suggestions/circles?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  suggestVoices: (query: string, limit = 20) =>
    getJSON<MetadataSuggestionResponse<VoiceSuggestion>>(
      `/api/metadata-suggestions/voices?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
  suggestSeries: (query: string, circleId = "", limit = 20) =>
    getJSON<MetadataSuggestionResponse<SeriesSuggestion>>(
      `/api/metadata-suggestions/series?q=${encodeURIComponent(query)}&limit=${limit}${circleId.trim() ? `&circleId=${encodeURIComponent(circleId.trim())}` : ""}`,
    ),
  resolveWorkCode: (code: string, signal?: AbortSignal) =>
    getJSON<WorkResolveResponse>(`/api/works/${encodeURIComponent(code)}/resolve`, signal),
  resolveWorkEntityLink: (code: string, kind: WorkEntityLink["kind"], name = "") =>
    postJSONBody<WorkEntityLink>(`/api/works/${encodeURIComponent(code)}/entity-links/resolve`, { kind, name }),
  /** Read-only lookup of persisted relationships; Demo uses it because the resolver may sync metadata. */
  lookupWorkEntityLink: (code: string, kind: WorkEntityLink["kind"], name = "") =>
    getJSON<WorkEntityLink>(
      `/api/works/${encodeURIComponent(code)}/entity-links?${new URLSearchParams({ kind, name })}`,
    ),
  listFavoriteLists: (signal?: AbortSignal) => getJSON<FavoriteList[]>("/api/favorite-lists", signal),
  createFavoriteList: (payload: { name: string; description?: string; icon?: string }) =>
    postJSONBody<FavoriteList>("/api/favorite-lists", payload),
  updateFavoriteList: (
    id: number,
    payload: { name?: string; description?: string; icon?: string; sortOrder?: number },
  ) => patchJSONBody<FavoriteList>(`/api/favorite-lists/${id}`, payload),
  deleteFavoriteList: (id: number) => deleteJSON<{ ok: boolean; deleted: number }>(`/api/favorite-lists/${id}`),
  listFavoriteListWorkIDs: (id: number) => getJSON<FavoriteListWorkIDs>(`/api/favorite-lists/${id}/work-ids`),
  getWorkFavoriteLists: (id: number) => getJSON<FavoriteList[]>(`/api/works/${id}/favorite-lists`),
  setWorkFavoriteLists: (id: number, listIds: number[]) =>
    putJSONBody<{ workId: number; favorite: boolean; lists: FavoriteList[] }>(`/api/works/${id}/favorite-lists`, {
      listIds,
    }),
  summarizeFavoriteListMembership: (workIds: number[]) =>
    postJSONBody<FavoriteListMembershipSummary>("/api/favorite-lists/membership/summary", { workIds }),
  /** Adds and removes works in one transaction; lists named in neither set keep their membership. */
  updateFavoriteListMembership: (payload: { workIds: number[]; addListIds: number[]; removeListIds: number[] }) =>
    postJSONBody<{ updated: number }>("/api/favorite-lists/membership", payload),
  listUserTags: (scope: UserTagScope, signal?: AbortSignal) =>
    sharedGetJSON<{ scope: UserTagScope; tags: UserTagSuggestion[] }>(`/api/tags?scope=${scope}`, signal),
  setWorkUserTags: (id: number, tags: string[]) =>
    putJSONBody<{ workId: number; userTags: UserTag[] }>(`/api/works/${id}/tags`, { tags }),
  getMediaText: (locationId: number) => getJSON<MediaTextPreview>(`/api/media/${locationId}/text`),
  getVideoPlaybackInfo: (locationId: number, capabilities: string[], forceTranscode = false, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (capabilities.length > 0) query.set("capabilities", capabilities.join(","));
    if (forceTranscode) query.set("forceTranscode", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return getJSON<VideoPlaybackInfo>(`/api/media/${locationId}/playback${suffix}`, signal);
  },
  setMediaLyricsPreference: (audioMediaItemId: number, lyricsMediaItemId: number) =>
    putJSONBody<{ audioMediaItemId: number; lyricsMediaItemId: number }>(
      `/api/media/${audioMediaItemId}/lyrics-preference`,
      { lyricsMediaItemId },
    ),
  clearMediaLyricsPreference: (audioMediaItemId: number) =>
    deleteJSON<{ audioMediaItemId: number; lyricsMediaItemId: null }>(
      `/api/media/${audioMediaItemId}/lyrics-preference`,
    ),
  fetchWorkLyrics: (workId: number, request: LyricsFetchRequest) =>
    postJSONBody<LyricsFetchResult>(`/api/works/${workId}/lyrics-fetch`, request),
  setWorkLyricsAssignments: (workId: number, assignments: LyricsAssignmentChange[]) =>
    putJSONBody<{ workId: number; assignments: LyricsAssignmentChange[] }>(`/api/works/${workId}/lyrics-assignments`, {
      assignments,
    }),
  cacheMediaLocation: (locationId: number) => postJSON<MediaCacheResult>(`/api/media/${locationId}/cache`),
  cacheRemoteSourceWorkMedia: (id: number, code: string, path: string) =>
    postJSONBody<MediaCacheResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/cache`, { path }),
  getCacheOverview: () => getJSON<CacheOverview>("/api/cache/overview"),
  clearTranscodeCache: () => deleteJSON<TranscodeCacheClearResult>("/api/cache/transcodes"),
  cleanupCache: (payload: { mode: "orphans"; groupKeys: string[] } | { mode: "works"; workIds: number[] }) =>
    postJSONBody<CacheMaintenanceResult>("/api/cache/cleanup", payload),
  deleteMediaCacheLocation: (locationId: number) => deleteJSON<MediaCleanupResult>(`/api/media/${locationId}/cache`),
  deleteMediaLocalLocation: (locationId: number) => deleteJSON<MediaCleanupResult>(`/api/media/${locationId}/local`),
  cleanupMediaLocations: (targets: MediaCleanupTarget[], mode: MediaCleanupMode = "files_only") =>
    postJSONBody<MediaCleanupResult>("/api/media/cleanup", { targets, mode }),
  updateWorkUserState: (id: number, payload: { listeningStatus?: ListeningStatus }) =>
    patchJSONBody<{ workId: number; listeningStatus: ListeningStatus; favorite: boolean }>(
      `/api/works/${id}/user-state`,
      payload,
    ),
  listCircles: async (options: CreatorListOptions = {}) => {
    const search = creatorListSearch(options);
    const page = await getJSON<CircleSummaryPage>(`/api/circles${search}`, options.signal);
    return { ...page, circles: page.circles.map(normalizeCreatorSyncState) };
  },
  getCircle: async (externalId: string, signal?: AbortSignal) =>
    normalizeCreatorSyncState(await getJSON<CircleDetail>(`/api/circles/${encodeURIComponent(externalId)}`, signal)),
  listVoices: async (options: CreatorListOptions = {}) => {
    const search = creatorListSearch(options);
    const page = await getJSON<VoiceSummaryPage>(`/api/voices${search}`, options.signal);
    return { ...page, voices: page.voices.map(normalizeCreatorSyncState) };
  },
  getVoice: async (personId: number | string) =>
    normalizeCreatorSyncState(await getJSON<VoiceDetail>(`/api/voices/${encodeURIComponent(String(personId))}`)),
  getVoiceSummary: async (personId: number | string, signal?: AbortSignal) =>
    normalizeCreatorSyncState(
      await getJSON<VoiceDetail>(`/api/voices/${encodeURIComponent(String(personId))}?includeWorks=false`, signal),
    ),
  getVoiceWorks: (personId: number | string, signal?: AbortSignal) =>
    getJSON<{ personId: number; works: VoiceKnownWork[] }>(
      `/api/voices/${encodeURIComponent(String(personId))}/works`,
      signal,
    ),
  getVoiceRemoteMatches: (personId: number | string, signal?: AbortSignal) =>
    getJSON<{ personId: number; remoteMatches: VoiceRemoteSourceSet[]; refresh: VoiceCatalogRefreshState }>(
      `/api/voices/${encodeURIComponent(String(personId))}/remote-matches`,
      signal,
    ),
  refreshVoiceCatalog: (personId: number | string, payload: CreatorRefreshRequest) =>
    postJSONBody<VoiceCatalogRefreshState>(
      `/api/voices/${encodeURIComponent(String(personId))}/catalog/refresh`,
      payload,
    ),
  listVoiceAliasCandidates: (personId: number, query = "") =>
    getJSON<VoiceAliasCandidate[]>(
      `/api/voices/${personId}/alias-candidates${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
    ),
  createVoiceAlias: (personId: number, alias: string) =>
    postJSONBody<VoiceAlias[]>(`/api/voices/${personId}/aliases`, { alias }),
  deleteVoiceAlias: (personId: number, aliasId: number) =>
    deleteJSON<{ deleted: number; aliases: VoiceAlias[] }>(`/api/voices/${personId}/aliases/${aliasId}`),
  mergeVoiceAliasCandidate: (personId: number, sourcePersonId: number) =>
    postJSONBody<{
      mergeId: number;
      targetPersonId: number;
      sourcePersonId: number;
      targetName: string;
      mergedName: string;
    }>(`/api/voices/${personId}/merge`, { sourcePersonId }),
  listVoiceMergeReviews: (personId: number) => getJSON<VoiceMergeReview[]>(`/api/voices/${personId}/merges`),
  undoVoiceMerge: (personId: number, mergeId: number) =>
    postJSON<{ mergeId: number; targetPersonId: number; restoredPersonId: number; restoredName: string }>(
      `/api/voices/${personId}/merges/${mergeId}/undo`,
    ),
  updateVoiceUserState: async (
    personId: number,
    payload: { rating?: number | null; note?: string; favorite?: boolean },
  ) => normalizeCreatorSyncState(await patchJSONBody<VoiceSummary>(`/api/voices/${personId}/user-state`, payload)),
  setVoiceUserTags: (personId: number, tags: string[]) =>
    putJSONBody<{ personId: number; userTags: VoiceUserTag[] }>(`/api/voices/${personId}/tags`, { tags }),
  updateCircleUserState: async (
    externalId: string,
    payload: { rating?: number | null; note?: string; favorite?: boolean },
  ) =>
    normalizeCreatorSyncState(
      await patchJSONBody<CircleSummary>(`/api/circles/${encodeURIComponent(externalId)}/user-state`, payload),
    ),
  setCircleUserTags: (externalId: string, tags: string[]) =>
    putJSONBody<{ externalId: string; userTags: VoiceUserTag[] }>(
      `/api/circles/${encodeURIComponent(externalId)}/tags`,
      { tags },
    ),
  refreshCircle: (externalId: string, payload: CreatorRefreshRequest) =>
    postJSONBody<CreatorRefreshRun>(`/api/circles/${encodeURIComponent(externalId)}/refresh`, payload),
  deleteCircleCatalogWork: (externalId: string, code: string) =>
    deleteJSON<{ ok: boolean; deleted: number }>(
      `/api/circles/${encodeURIComponent(externalId)}/catalog/${encodeURIComponent(code)}`,
    ),
  updateMediaProgress: (
    id: number,
    payload: { locationId: number; positionSeconds: number; durationSeconds: number | null; completed: boolean },
    signal?: AbortSignal,
  ) => sendJSONBody<MediaProgressUpdate>("PATCH", `/api/media-items/${id}/progress`, payload, { signal }),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  getSettings: () => getJSON<AppSettings>("/api/settings"),
  updateAccessPolicy: (payload: AccessPolicy) => patchJSONBody<AccessPolicy>("/api/access-policy", payload),
  updateSettings: (payload: {
    localScanDepth?: number;
    cacheEnabled?: boolean;
    cacheLimitGb?: number;
    transcodeCacheLimitGb?: number;
    remoteDownloadLimitGb?: number;
    fetchStagingRetentionDays?: number;
    remoteSaveTemplate?: string;
    remoteDelayBaseSeconds?: number;
    remoteDelayRandomSeconds?: number;
    remoteBackoffSeconds?: number;
    remoteMaxBackoffSeconds?: number;
    catalogFreshnessDays?: number;
    remoteMetadataFallback?: RemoteMetadataFallbackSettings;
    purchaseBonusAutoLink?: boolean;
    proxy?: ProxySettingsPayload;
    kikoeruImportPrivateAddresses?: boolean;
    directoryRoutingRules?: DirectoryRoutingRule[];
    recommendationThreshold?: number;
    recommendationConfig?: RecommendationConfig;
  }) => patchJSONBody<AppSettings>("/api/settings", payload),
  createFileSource: (payload: {
    displayName: string;
    sourceType: string;
    priority: number;
    enabled: boolean;
    config: FileSource["config"];
    endpoint: FileSource["endpoint"];
  }) => postJSONBody<FileSource>("/api/file-sources", payload),
  updateFileSource: (
    id: number,
    payload: {
      displayName: string;
      sourceType: string;
      priority: number;
      enabled: boolean;
      config: FileSource["config"];
      endpoint: FileSource["endpoint"];
    },
  ) => patchJSONBody<FileSource>(`/api/file-sources/${id}`, payload),
  deleteFileSource: (id: number) => deleteJSON<{ ok: boolean }>(`/api/file-sources/${id}`),
  checkFileSourceHealth: (id: number) => postJSON<FileSourceHealthCheckResult>(`/api/file-sources/${id}/health-check`),
  detectFileSource: (url: string, signal?: AbortSignal) =>
    postJSONBody<FileSourceDetectResult>("/api/file-sources/detect", { url }, signal),
  getDatabaseMaintenance: () => getJSON<DatabaseMaintenanceOverview>("/api/maintenance/database"),
  cleanupDatabase: (tasks: DatabaseCleanupTaskKey[]) =>
    postJSONBody<DatabaseCleanupResult>("/api/maintenance/database/cleanup", { tasks }),
  optimizeDatabase: () => postJSONBody<DatabaseOptimizeResult>("/api/maintenance/database/optimize", {}),
  getLibraryLayout: (signal?: AbortSignal) => getJSON<LibraryLayout>("/api/library/layout", signal),
  updateLibraryLayout: (payload: LibraryLayoutUpdate) => putJSONBody<LibraryLayout>("/api/library/layout", payload),
  previewLibraryMigration: (layout: LibraryLayoutUpdate) =>
    postJSONBody<LibraryMigrationPreview>("/api/library/migration/preview", layout),
  startLibraryMigration: (layout: LibraryLayoutUpdate, hash: string) =>
    postJSONBody<LibraryMigrationStatus>("/api/library/migration", { layout, hash }),
  getLibraryMigration: () => getJSON<LibraryMigrationStatus>("/api/library/migration"),
  getPublicLibraryMigration: () => getJSON<{ maintenance: boolean }>("/api/library/migration/public"),
  retryLibraryMigration: () => postJSONBody<LibraryMigrationStatus>("/api/library/migration/retry", {}),
  listLegacyWorkflowMigrations: () => getJSON<LegacyWorkflowMigrationItem[]>("/api/library/legacy-workflows"),
  convertLegacyWorkflow: (id: number) =>
    postJSONBody<{ preset: string; triggersCreated: number; enabled: boolean }>(
      `/api/library/legacy-workflows/${id}/convert`,
      {},
    ),
  skipLegacyWorkflow: (id: number) => postJSONBody<{ ok: boolean }>(`/api/library/legacy-workflows/${id}/skip`, {}),
  exportLegacyWorkflow: (id: number) => getJSON<unknown>(`/api/library/legacy-workflows/${id}/export`),
  reconnectLibraryPool: (path: string) => postJSONBody<LibraryLayout>("/api/library/pools/reconnect", { path }),
  completeLibraryOnboarding: (payload: { startupScan: boolean; watchFolders: boolean }) =>
    postJSONBody<LibraryLayout>("/api/library/onboarding/complete", payload),
  listDatabaseBackups: () => getJSON<DatabaseBackupList>("/api/maintenance/database/backups"),
  backUpDatabase: () => postJSONBody<DatabaseOptimizeResult>("/api/maintenance/database/backups", {}),
  listWorkflowDefinitions: () => getJSON<WorkflowDefinition[]>("/api/workflow-definitions"),
  getAvailabilityWatch: () => getJSON<AvailabilityWatch>("/api/availability-watch"),
  updateAvailabilityWatch: (payload: {
    action: AvailabilityWatch["action"];
    sourceId: number | null;
    excludeExtensions: string[];
  }) => putJSONBody<AvailabilityWatch>("/api/availability-watch", payload),
  updateAvailabilityWatchTargets: (targetCodes: string[]) =>
    putJSONBody<AvailabilityWatch>("/api/availability-watch/targets", { targetCodes }),
  addAvailabilityWatchTargets: (targetCodes: string[]) =>
    postJSONBody<AvailabilityWatch>("/api/availability-watch/targets", { targetCodes }),
  removeAvailabilityWatchTarget: (id: number) => deleteJSON<{ ok: boolean }>(`/api/availability-watch/targets/${id}`),
  trackAvailabilityWatchTarget: (id: number) =>
    postJSON<RemoteWorkTrackResult>(`/api/availability-watch/targets/${id}/track`),
  runAvailabilityWatch: () => postJSON<AvailabilityWatchRunResult>("/api/availability-watch/run"),
  listWorkflowTriggers: () => getJSON<WorkflowTrigger[]>("/api/workflow-triggers"),
  createWorkflowTrigger: (payload: {
    workflowDefinitionId: number;
    displayName: string;
    triggerType: string;
    enabled: boolean;
    scheduleJson: string;
    configJson: string;
    nextRunAt: string | null;
  }) => postJSONBody<WorkflowTrigger>("/api/workflow-triggers", payload),
  updateWorkflowTrigger: (
    id: number,
    payload: {
      workflowDefinitionId: number;
      displayName: string;
      triggerType: string;
      enabled: boolean;
      scheduleJson: string;
      configJson: string;
      nextRunAt: string | null;
    },
  ) => patchJSONBody<WorkflowTrigger>(`/api/workflow-triggers/${id}`, payload),
  deleteWorkflowTrigger: (id: number) => deleteJSON<{ ok: boolean }>(`/api/workflow-triggers/${id}`),
  listWorkflowRuns: (page = 1, pageSize = 10, view = "running", query = "", workflowCode = "", signal?: AbortSignal) =>
    getJSON<WorkflowRunsPage>(
      `/api/workflow-runs?page=${page}&pageSize=${pageSize}&view=${encodeURIComponent(view)}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}${workflowCode.trim() ? `&workflowCode=${encodeURIComponent(workflowCode.trim())}` : ""}`,
      signal,
    ),
  getWorkflowRun: (id: number) => getJSON<WorkflowRunDetail>(`/api/workflow-runs/${id}`),
  listWorkflowRunEvents: (id: number, afterId = 0) =>
    getJSON<WorkflowEvent[]>(`/api/workflow-runs/${id}/events${afterId > 0 ? `?afterId=${afterId}` : ""}`),
  streamWorkflowRunEvents: (
    id: number,
    afterId: number,
    signal: AbortSignal,
    onMessage: (message: WorkflowRunEventStreamMessage) => void,
  ) => streamWorkflowRunEvents(id, afterId, signal, onMessage),
  listWorkflowRunCandidates: (id: number) => getJSON<WorkflowCandidate[]>(`/api/workflow-runs/${id}/candidates`),
  listWorkflowRunFetchFiles: (id: number) =>
    getJSON<{ runId: number; files: FetchFile[] }>(`/api/workflow-runs/${id}/fetch-files`),
  updateWorkflowCandidate: (
    id: number,
    payload: { status: "accepted" | "rejected" | "ignored" | "resolved"; decisionJson?: string },
  ) =>
    patchJSONBody<WorkflowCandidate>(`/api/workflow-candidates/${id}`, {
      status: payload.status,
      decisionJson: payload.decisionJson ?? "{}",
    }),
  cleanupLocalWorkflowCandidate: (
    id: number,
    payload: { action: "mark_unavailable" | "delete_files"; locationIds?: number[] },
  ) => postJSONBody<LocalCandidateCleanupResult>(`/api/workflow-candidates/${id}/local-cleanup`, payload),
  reviewArchivedFetchRoots: (id: number, action: "keep_archived" | "delete_archived", confirm = "") =>
    postJSONBody<{ candidateId: number; status: string; action: string }>(
      `/api/workflow-candidates/${id}/archived-root-review`,
      { action, confirm },
    ),
  cancelWorkflowRun: (id: number) => postJSON<WorkflowRunActionResult>(`/api/workflow-runs/${id}/cancel`),
  retryWorkflowRun: (id: number) => postJSON<WorkflowRunActionResult>(`/api/workflow-runs/${id}/retry`),
  reviewWorkflowRun: (id: number) => postJSON<WorkflowRun>(`/api/workflow-runs/${id}/review`),
  recoverStaleWorkflowRuns: () => postJSON<WorkflowRunActionResult>("/api/workflow-runs/recover-stale"),
  runLocalScan: (payload: { followUpRun: boolean } = { followUpRun: false }) =>
    postJSONBody<LocalScanResult>("/api/workflow-runs/local-scan", payload),
  runLocalMediaIndex: (payload: { mode: LocalMediaIndexMode }) =>
    postJSONBody<LocalMediaIndexResult>("/api/workflow-runs/local-media-index", payload),
  runSourcePresenceCheck: (payload: SourcePresenceCheckOptions) =>
    postJSONBody<SourcePresenceCheckResult>("/api/workflow-runs/source-presence-check", payload),
  runRemotePopularCollection: (payload: {
    action: "track" | "fetch";
    sourceId: number;
    limit: number;
    tagNameTemplate: string;
    skipTag?: boolean;
  }) => postJSONBody<RemoteCollectionRunResult>("/api/workflow-runs/remote-popular", payload),
  listWorkflowPresets: () => getJSON<WorkflowPreset[]>("/api/workflow-presets"),
  runWorkflowPreset: (code: string, inputs: Record<string, unknown>) =>
    postJSONBody<WorkflowPresetRunResult>(`/api/workflow-presets/${encodeURIComponent(code)}/runs`, { inputs }),
  runDLsitePopularCollection: (payload: {
    period: "day" | "week" | "month" | "year";
    releaseWindow: "30d" | "";
    year: number;
    tagNameTemplate: string;
    skipTag?: boolean;
  }) => postJSONBody<DLsitePopularRunResult>("/api/workflow-runs/dlsite-popular", payload),
  recordRemoteBulkRun: (payload: {
    action: "track" | "fetch" | "track_fetch" | "sync" | "sync_fetch" | "save" | "sync_save";
    sourceId: number;
    codes: string[];
  }) =>
    postJSONBody<{
      runId: number;
      sourceId: number;
      action: string;
      codes: string[];
      status: string;
      synced: number;
      fetched: number;
      failed: number;
      failures: string[];
      childRuns: number[];
    }>("/api/workflow-runs/remote-bulk", payload),
  runDLsiteSync: (options?: MetadataSyncOptions) =>
    options
      ? postJSONBody<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync", options)
      : postJSON<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync"),
  syncWorkMetadata: (workId: number, sourceId?: number) =>
    sourceId === undefined
      ? postJSON<WorkMetadataSyncRunResult>(`/api/works/${workId}/metadata-sync`)
      : postJSONBody<WorkMetadataSyncRunResult>(`/api/works/${workId}/metadata-sync`, { sourceId }),
  listMetadataIssues: (page: number, query: string, status: string, runId: number | null, signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(page), q: query, status });
    if (runId) params.set("runId", String(runId));
    return getJSON<MetadataIssuePage>(`/api/metadata/issues?${params}`, signal);
  },
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
  retryMetadataIssues: (workIds: number[]) =>
    postJSONBody<{ queued: number; skipped: number; failed: number }>("/api/metadata/issues/retry", { workIds }),
  getMetadataOnboarding: (signal?: AbortSignal) => getJSON<MetadataOnboarding>("/api/metadata/onboarding", signal),
  startMetadataOnboarding: () => postJSONBody<MetadataOnboarding>("/api/metadata/onboarding/start", {}),
  dismissMetadataOnboarding: () => postJSONBody<MetadataOnboarding>("/api/metadata/onboarding/dismiss", {}),
};
import {
  clearStoredSessionToken,
  getStoredServerURL,
  getStoredSessionToken,
  isNativeApp,
  setStoredSessionToken,
} from "@/lib/serverConfig";
import { recordApiError } from "@/lib/mobileDiagnostics";
import { nativeAssetURL } from "@/lib/nativeAssetTransport";

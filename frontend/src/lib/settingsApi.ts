import {
  deleteJSON,
  getJSON,
  patchJSONBody,
  postJSON,
  postJSONBody,
  putJSONBody,
  sharedGetJSON,
} from "@/lib/apiTransport";
import type { RecommendationConfig } from "@/lib/libraryApi";

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
  /** Keeps remote source addresses from accounts without sources:write and from signed-out readers. */
  hideRemoteSourceAddresses: boolean;
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

export type FileSourceHealthCheckResult = {
  healthy: boolean;
  healthStatus: string;
  lastCheckedAt: string | null;
  elapsedMs: number;
};

export const settingsApi = {
  appUpdate: () => getJSON<AppUpdate>("/api/app-update"),
  getRuntimeSettings: (signal?: AbortSignal): Promise<RuntimeSettings> =>
    sharedGetJSON("/api/runtime-settings", signal),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  getSettings: () => getJSON<AppSettings>("/api/settings"),
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
    hideRemoteSourceAddresses?: boolean;
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
};

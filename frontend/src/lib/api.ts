export type Work = {
  id: number;
  primaryCode: string;
  title: string;
  createdAt: string;
  coverUrl: string;
  dlsiteUrl: string;
  circle: string;
  rating: number | null;
  tags: string[];
  voiceActors: string[];
  trackCount: number;
  availableLocations: number;
  availability: string[];
  listeningStatus: ListeningStatus;
};

export type WorkDetail = {
  id: number;
  primaryCode: string;
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
  rating: number | null;
  tags: string[];
  voiceActors: string[];
  listeningStatus: ListeningStatus;
  mediaItems: MediaItem[];
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
  sizeBytes: number | null;
  fingerprint: string;
  progress: MediaProgress | null;
  locations: MediaFileLocation[];
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
    autoSyncOnInterest?: boolean;
    cacheEnabled?: boolean;
    cacheLimitGb?: number;
    saveRootTemplate?: string;
    scanDepth?: number;
  };
  endpoint: {
    baseUrl: string;
    apiUrl: string;
    fallbackUrl: string;
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
  autoSyncOnInterest: boolean;
  cacheEnabled: boolean;
};

export type RuntimeSettings = {
  autoSyncRemote: boolean;
  cacheEnabled: boolean;
};

export type AppSettings = {
  localScanDepth: number;
  autoSyncRemote: boolean;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  remoteSaveTemplate: string;
  dataRoot: string;
  cacheRoot: string;
  fileSources: FileSource[];
};

export type RemoteWorksResponse = {
  sourceId: number;
  works: RemoteWork[];
  page: number;
  pageSize: number;
  total: number;
  status: string;
};

export type RemoteWork = {
  remoteId: string;
  primaryCode: string;
  title: string;
  coverUrl: string;
  circle: string;
  rating: number | null;
  tags: string[];
  importStatus: string;
  remotePlayable: boolean;
  workId: number | null;
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
  title: string;
  coverUrl: string;
  sourceUrl: string;
  circle: string;
  rating: number | null;
  releaseDate: string;
  durationSeconds: number | null;
  tags: string[];
  voiceActors: string[];
  importStatus: string;
  workId: number | null;
  tracks: RemoteTrack[];
};

export type RemoteWorkSyncResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  syncedMediaItems: number;
  syncedLocations: number;
  triggerReason: string;
};

export type RemoteWorkSaveSummary = {
  total: number;
  skipExisting: number;
  copyCache: number;
  download: number;
};

export type RemoteWorkSavePlanItem = {
  path: string;
  kind: string;
  sizeBytes: number | null;
  action: string;
  status: string;
  sourcePath: string;
  targetPath: string;
};

export type RemoteWorkSavePlan = {
  sourceId: number;
  primaryCode: string;
  saveRoot: string;
  items: RemoteWorkSavePlanItem[];
  summary: RemoteWorkSaveSummary;
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
  copiedFromCache: number;
  downloadedFiles: number;
  plan: RemoteWorkSaveSummary;
};

export type WorkflowRun = {
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
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  candidateCount: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  definitionId: number | null;
  triggerId: number | null;
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

export type WorkflowRunDetail = WorkflowRun & {
  nodeRuns: WorkflowNodeRun[];
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
  role: "super_admin" | "admin" | "user";
  permissions: string[];
  devMode: boolean;
};

export type ManagedUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "admin" | "user";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuthState =
  | { authenticated: false }
  | { authenticated: true; user: CurrentUser };

export type LocalScanResult = {
  runId: number;
  jobId: number;
  fileSourceId: number;
  status: string;
  detectedWorks: number;
  scannedFiles: number;
  updatedLocations: number;
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

export type MediaCacheDeleteResult = {
  runId: number;
  locationId: number;
  cachePath: string;
  status: string;
  deleted: boolean;
};

export type MediaLocalDeleteResult = {
  runId: number;
  locationId: number;
  workId: number;
  path: string;
  status: string;
  deleted: boolean;
  clearedProgress: number;
  clearedWorkStates: number;
};

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:7659";

export function assetURL(path: string) {
  if (!path) return "";
  if (path.startsWith("http")) return path;
  return `${API_BASE}${path}`;
}

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", credentials: "include" });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJSONBody<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `POST ${path} failed with ${response.status}` }));
    throw new Error(payload.error ?? `POST ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function patchJSONBody<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `PATCH ${path} failed with ${response.status}` }));
    throw new Error(payload.error ?? `PATCH ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function deleteJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: "DELETE", credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: `DELETE ${path} failed with ${response.status}` }));
    throw new Error(payload.error ?? `DELETE ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  me: () => getJSON<AuthState>("/api/auth/me"),
  login: (username: string, password: string) => postJSONBody<AuthState>("/api/auth/login", { username, password }),
  logout: () => postJSON<{ ok: boolean }>("/api/auth/logout"),
  listUsers: () => getJSON<ManagedUser[]>("/api/users"),
  createUser: (payload: { username: string; displayName: string; role: ManagedUser["role"]; password: string; enabled: boolean }) =>
    postJSONBody<ManagedUser>("/api/users", payload),
  updateUser: (
    id: number,
    payload: { displayName?: string; role?: ManagedUser["role"]; password?: string; enabled?: boolean },
  ) => patchJSONBody<ManagedUser>(`/api/users/${id}`, payload),
  deleteUser: (id: number) => deleteJSON<{ ok: boolean }>(`/api/users/${id}`),
  listWorks: () => getJSON<Work[]>("/api/works"),
  listLibrarySources: () => getJSON<LibrarySource[]>("/api/library-sources"),
  getRuntimeSettings: () => getJSON<RuntimeSettings>("/api/runtime-settings"),
  listRemoteSourceWorks: (id: number, page = 1, pageSize = 24, query = "") =>
    getJSON<RemoteWorksResponse>(
      `/api/remote-sources/${id}/works?page=${page}&pageSize=${pageSize}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}`,
    ),
  getRemoteSourceWork: (id: number, code: string) =>
    getJSON<RemoteWorkDetail>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}`),
  planRemoteSourceWorkSave: (id: number, code: string, paths: string[]) =>
    postJSONBody<RemoteWorkSavePlan>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/save-plan`, { paths }),
  saveRemoteSourceWork: (id: number, code: string, paths: string[]) =>
    postJSONBody<RemoteWorkSaveResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/save`, { paths }),
  syncRemoteSourceWork: (id: number, code: string, triggerReason: string) =>
    postJSONBody<RemoteWorkSyncResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/sync`, { triggerReason }),
  getWork: (id: number) => getJSON<WorkDetail>(`/api/works/${id}`),
  getMediaText: (locationId: number) => getJSON<MediaTextPreview>(`/api/media/${locationId}/text`),
  cacheMediaLocation: (locationId: number) => postJSON<MediaCacheResult>(`/api/media/${locationId}/cache`),
  cacheRemoteSourceWorkMedia: (id: number, code: string, path: string) =>
    postJSONBody<MediaCacheResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/cache`, { path }),
  deleteMediaCacheLocation: (locationId: number) => deleteJSON<MediaCacheDeleteResult>(`/api/media/${locationId}/cache`),
  deleteMediaLocalLocation: (locationId: number) => deleteJSON<MediaLocalDeleteResult>(`/api/media/${locationId}/local`),
  updateWorkUserState: (id: number, payload: { listeningStatus: ListeningStatus }) =>
    patchJSONBody<{ workId: number; listeningStatus: ListeningStatus }>(`/api/works/${id}/user-state`, payload),
  updateMediaProgress: (
    id: number,
    payload: { positionSeconds: number; durationSeconds: number | null; completed: boolean },
  ) => patchJSONBody<{ mediaItemId: number; positionSeconds: number; durationSeconds: number | null; completed: boolean; lastPlayedAt: string | null }>(
    `/api/media-items/${id}/progress`,
    payload,
  ),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  getSettings: () => getJSON<AppSettings>("/api/settings"),
  updateSettings: (payload: {
    localScanDepth?: number;
    autoSyncRemote?: boolean;
    cacheEnabled?: boolean;
    cacheLimitGb?: number;
    remoteSaveTemplate?: string;
  }) =>
    patchJSONBody<AppSettings>("/api/settings", payload),
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
  listWorkflowDefinitions: () => getJSON<WorkflowDefinition[]>("/api/workflow-definitions"),
  createWorkflowDefinition: (payload: { code: string; displayName: string; description: string; definitionJson: string }) =>
    postJSONBody<WorkflowDefinition>("/api/workflow-definitions", payload),
  updateWorkflowDefinition: (
    id: number,
    payload: { code: string; displayName: string; description: string; definitionJson: string },
  ) => patchJSONBody<WorkflowDefinition>(`/api/workflow-definitions/${id}`, payload),
  deleteWorkflowDefinition: (id: number) => deleteJSON<{ ok: boolean }>(`/api/workflow-definitions/${id}`),
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
  listWorkflowRuns: () => getJSON<WorkflowRun[]>("/api/workflow-runs"),
  getWorkflowRun: (id: number) => getJSON<WorkflowRunDetail>(`/api/workflow-runs/${id}`),
  runLocalScan: () => postJSON<LocalScanResult>("/api/workflow-runs/local-scan"),
  runDLsiteSync: () => postJSON<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync"),
};

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
  mediaItems: MediaItem[];
};

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
  locations: MediaFileLocation[];
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
  enabled: boolean;
};

export type WorkflowRun = {
  id: number;
  templateCode: string;
  status: string;
  triggerReason: string;
  createdAt: string;
};

export type CurrentUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "admin" | "user";
  permissions: string[];
  devMode: boolean;
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

export const api = {
  me: () => getJSON<AuthState>("/api/auth/me"),
  login: (username: string, password: string) => postJSONBody<AuthState>("/api/auth/login", { username, password }),
  logout: () => postJSON<{ ok: boolean }>("/api/auth/logout"),
  listWorks: () => getJSON<Work[]>("/api/works"),
  getWork: (id: number) => getJSON<WorkDetail>(`/api/works/${id}`),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  listWorkflowRuns: () => getJSON<WorkflowRun[]>("/api/workflow-runs"),
  runLocalScan: () => postJSON<LocalScanResult>("/api/workflow-runs/local-scan"),
  runDLsiteSync: () => postJSON<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync"),
};

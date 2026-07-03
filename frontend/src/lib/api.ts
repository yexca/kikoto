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

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:7659";

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function postJSON<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`POST ${path} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  listWorks: () => getJSON<Work[]>("/api/works"),
  getWork: (id: number) => getJSON<WorkDetail>(`/api/works/${id}`),
  listFileSources: () => getJSON<FileSource[]>("/api/file-sources"),
  listWorkflowRuns: () => getJSON<WorkflowRun[]>("/api/workflow-runs"),
  runLocalScan: () => postJSON<LocalScanResult>("/api/workflow-runs/local-scan"),
  runDLsiteSync: () => postJSON<DLsiteSyncResult>("/api/workflow-runs/dlsite-sync"),
};

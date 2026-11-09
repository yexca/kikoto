import { postJSON, putJSONBody, sharedGetJSON } from "@/lib/apiTransport";

export type RecordRoot = {
  id: number;
  displayName: string;
  state: "unconfigured" | "online" | "offline" | "unreadable";
  lastScannedAt?: string;
  scanGeneration: number;
};

export type RecordArtwork = {
  posterUrl?: string;
  backdropUrl?: string;
};

export type RecordFolder = {
  id: number;
  parentId?: number;
  name: string;
  relativePath?: string;
  depth: number;
  childCount: number;
  assetCount: number;
  artwork: RecordArtwork;
};

export type RecordAsset = {
  id: number;
  folderId: number;
  name: string;
  relativePath?: string;
  kind: "video" | "image" | "subtitle" | "metadata" | "other";
  mimeType: string;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  availability: "available" | "missing" | "unreadable";
  streamUrl?: string;
};

export type RecordTree = {
  folderId: number;
  folders: RecordFolder[];
  assets: RecordAsset[];
};

export type RecordProgress = {
  positionSeconds: number;
  durationSeconds?: number;
  completed: boolean;
  lastPlayedAt?: string;
};

export type RecordScan = {
  runId: number;
  jobId: number;
  status: string;
  existing?: boolean;
};

export const recordsApi = {
  getRecordRoot: () => sharedGetJSON<{ root: RecordRoot }>("/api/records"),
  initializeRecordRoot: () => postJSON<{ root: RecordRoot }>("/api/records/root/initialize"),
  listRecordTree: (folderId?: number, signal?: AbortSignal) =>
    sharedGetJSON<RecordTree>(
      folderId ? `/api/records/tree?folderId=${encodeURIComponent(folderId)}` : "/api/records/tree",
      signal,
    ),
  getRecordAsset: (id: number, signal?: AbortSignal) =>
    sharedGetJSON<{ asset: RecordAsset }>(`/api/records/assets/${id}`, signal),
  queueRecordScan: () => postJSON<RecordScan>("/api/records/scans"),
  getRecordProgress: (id: number, signal?: AbortSignal) =>
    sharedGetJSON<RecordProgress>(`/api/records/assets/${id}/progress`, signal),
  updateRecordProgress: (id: number, progress: RecordProgress) =>
    putJSONBody<void>(`/api/records/assets/${id}/progress`, progress),
};

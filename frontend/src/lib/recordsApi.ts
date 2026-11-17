import { getJSON, postJSON, putJSONBody, sharedGetJSON } from "@/lib/apiTransport";
import type { VideoPlaybackInfo } from "@/lib/mediaApi";

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
  kind: "video" | "audio" | "image" | "subtitle" | "metadata" | "other";
  mimeType: string;
  sizeBytes?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  availability: "available" | "missing" | "unreadable";
  /** The media stream for videos, audio, and images; WebVTT for a WebVTT or SubRip sidecar. */
  streamUrl?: string;
  /** A JPEG thumbnail of a video, an image, or an audio file's embedded cover art, made on first request. */
  thumbnailUrl?: string;
  /** The file as a download, for any available file. */
  downloadUrl?: string;
  /** The viewer's saved position for a video or audio file. */
  progress?: RecordProgress;
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
  listRecordContinue: (signal?: AbortSignal) =>
    sharedGetJSON<{ assets: RecordAsset[] }>("/api/records/continue", signal),
  queueRecordScan: () => postJSON<RecordScan>("/api/records/scans"),
  /**
   * How a record video or audio file plays, as library playback info answers:
   * directly, as a remux, or as a transcode. The audio profile plays only the
   * audio of a video.
   */
  getRecordPlayback: (
    id: number,
    options: { capabilities: string[]; profile?: "audio"; forceTranscode?: boolean },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams();
    if (options.capabilities.length > 0) query.set("capabilities", options.capabilities.join(","));
    if (options.profile) query.set("profile", options.profile);
    if (options.forceTranscode) query.set("forceTranscode", "1");
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return getJSON<VideoPlaybackInfo>(`/api/records/assets/${id}/playback${suffix}`, signal);
  },
  getRecordProgress: (id: number, signal?: AbortSignal) =>
    sharedGetJSON<RecordProgress>(`/api/records/assets/${id}/progress`, signal),
  updateRecordProgress: (id: number, progress: RecordProgress) =>
    putJSONBody<void>(`/api/records/assets/${id}/progress`, progress),
};

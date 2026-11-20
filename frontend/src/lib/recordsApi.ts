import { deleteJSONBody, getJSON, postJSON, postJSONBody, putJSONBody, sharedGetJSON } from "@/lib/apiTransport";
import type { VideoPlaybackInfo } from "@/lib/mediaApi";

export type RecordRoot = {
  id: number;
  displayName: string;
  /** marker_missing: the path is there without the catalog's marker; the catalog is browsed until it is restored. */
  state: "unconfigured" | "online" | "offline" | "unreadable" | "marker_missing";
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

/** One page of a folder's children: subfolders first, then files, each by name. */
export type RecordTree = {
  folderId: number;
  folders: RecordFolder[];
  assets: RecordAsset[];
  /** Every child the folder has, on every page. */
  total: number;
  /** Where the next page starts; absent on the last page. */
  nextOffset?: number;
};

export type RecordProgress = {
  positionSeconds: number;
  durationSeconds?: number;
  completed: boolean;
  lastPlayedAt?: string;
  /** When the client captured a save, in Unix milliseconds; the server keeps the latest. */
  order?: number;
};

export type RecordScan = {
  runId: number;
  jobId: number;
  status: string;
  existing?: boolean;
};

export const recordsApi = {
  getRecordRoot: () => sharedGetJSON<{ root: RecordRoot }>("/api/records"),
  /** `fresh` starts a new catalog in place of one whose marker is missing, forgetting it. */
  initializeRecordRoot: (options: { fresh?: boolean } = {}) =>
    options.fresh
      ? postJSONBody<{ root: RecordRoot }>("/api/records/root/initialize", { fresh: true })
      : postJSON<{ root: RecordRoot }>("/api/records/root/initialize"),
  /** Writes the marker of the kept catalog into a root that lost it. */
  restoreRecordMarker: () => postJSON<{ root: RecordRoot }>("/api/records/root/restore-marker"),
  listRecordTree: (folderId?: number, signal?: AbortSignal, offset = 0) => {
    const query = new URLSearchParams();
    if (folderId) query.set("folderId", String(folderId));
    if (offset > 0) query.set("offset", String(offset));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return sharedGetJSON<RecordTree>(`/api/records/tree${suffix}`, signal);
  },
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
  /** `stored` is false when the server already holds a save captured later. */
  updateRecordProgress: (id: number, progress: RecordProgress) =>
    putJSONBody<{ ok: boolean; stored?: boolean } | undefined>(`/api/records/assets/${id}/progress`, progress),
  /**
   * Moves a record file to the trash in the record root; `trashPath` is relative to that root.
   * `expectedPath` is the relative path the viewer confirmed; the server refuses an id that names another path.
   */
  deleteRecordAsset: (id: number, expectedPath: string) =>
    deleteJSONBody<{ trashPath: string }>(`/api/records/assets/${id}`, { expectedPath }),
  /** Moves a record folder with everything in it to the trash; `assetIds` are the files it held. */
  deleteRecordFolder: (id: number, expectedPath: string) =>
    deleteJSONBody<{ trashPath: string; assetIds: number[] }>(`/api/records/folders/${id}`, { expectedPath }),
};

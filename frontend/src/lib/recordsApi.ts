import { deleteJSONBody, getJSON, postJSON, postJSONBody, sendJSONBody, sharedGetJSON } from "@/lib/apiTransport";
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
  /** A video's same-name WebVTT or SubRip sidecar, served as WebVTT. */
  subtitle?: RecordAsset;
};

/**
 * The sections a folder shows, each in natural name order: subfolders, videos,
 * photos (without the folder's artwork), and its other files, audio among
 * them. `audio` is the folder's audio files alone, which the player queues.
 */
export type RecordSectionName = "folders" | "videos" | "photos" | "audio" | "files";

/** One page of a section. */
export type RecordSectionPage<T> = {
  items: T[];
  /** Every child the section has, on every page. */
  total: number;
  /** The cursor of the next page; absent on the last page. */
  next?: string;
};

export type RecordSectionPages = {
  folders: RecordSectionPage<RecordFolder>;
  videos: RecordSectionPage<RecordAsset>;
  photos: RecordSectionPage<RecordAsset>;
  audio: RecordSectionPage<RecordAsset>;
  files: RecordSectionPage<RecordAsset>;
};

/** A folder: its trail and the first page of each section. */
export type RecordTree = {
  folderId: number;
  /** The listed folder and the folders above it, below the root; empty at the root. */
  trail: RecordFolder[];
  sections: RecordSectionPages;
  /** Listed videos and audio files whose length or cover art the server is reading now. */
  mediaDetailsPending?: number;
};

/** Where a video, photo, or audio file sits in its section of its folder. */
export type RecordSiblings = {
  asset: RecordAsset;
  section: "videos" | "photos" | "audio";
  index: number;
  total: number;
  previous?: RecordAsset;
  next?: RecordAsset;
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

/** A record workflow run as the Records page follows it. */
export type RecordRunActivity = {
  runId: number;
  status: string;
  progressCurrent: number;
  /** Zero while the total is not known yet, as during a scan's walk. */
  progressTotal: number;
};

/** What the record workflows are doing. */
export type RecordActivity = {
  /** The latest scan, finished or not. */
  scan?: RecordRunActivity;
  /** The run reading media details, while it is queued or running. */
  probe?: RecordRunActivity;
  /** Videos and audio files whose length is still to be read. */
  pendingFiles: number;
};

export const recordsApi = {
  getRecordRoot: () => sharedGetJSON<{ root: RecordRoot; activity?: RecordActivity }>("/api/records"),
  /** `fresh` starts a new catalog in place of one whose marker is missing, forgetting it. */
  initializeRecordRoot: (options: { fresh?: boolean } = {}) =>
    options.fresh
      ? postJSONBody<{ root: RecordRoot }>("/api/records/root/initialize", { fresh: true })
      : postJSON<{ root: RecordRoot }>("/api/records/root/initialize"),
  /** Writes the marker of the kept catalog into a root that lost it. */
  restoreRecordMarker: () => postJSON<{ root: RecordRoot }>("/api/records/root/restore-marker"),
  listRecordTree: (folderId?: number, signal?: AbortSignal) =>
    sharedGetJSON<RecordTree>(folderId ? `/api/records/tree?folderId=${folderId}` : "/api/records/tree", signal),
  /** The page of one section that follows the cursor `after`. */
  listRecordSection: <S extends RecordSectionName>(
    folderId: number,
    section: S,
    after: string,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ section, after });
    if (folderId) query.set("folderId", String(folderId));
    return sharedGetJSON<RecordSectionPages[S]>(`/api/records/tree?${query.toString()}`, signal);
  },
  getRecordSiblings: (id: number, signal?: AbortSignal) =>
    sharedGetJSON<RecordSiblings>(`/api/records/assets/${id}/siblings`, signal),
  getRecordAsset: (id: number, signal?: AbortSignal) =>
    sharedGetJSON<{ asset: RecordAsset }>(`/api/records/assets/${id}`, signal),
  listRecordContinue: (signal?: AbortSignal) =>
    sharedGetJSON<{ assets: RecordAsset[] }>("/api/records/continue", signal),
  queueRecordScan: () => postJSON<RecordScan>("/api/records/scans"),
  /** Reads the media details still pending, or answers with the run already doing so. */
  queueRecordProbe: () => postJSON<RecordScan>("/api/records/probes"),
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
  /** Keeps alive past page close, so the save a closing page flushes still arrives. */
  updateRecordProgress: (id: number, progress: RecordProgress) =>
    sendJSONBody<{ ok: boolean; stored?: boolean } | undefined>("PUT", `/api/records/assets/${id}/progress`, progress, {
      keepalive: true,
    }),
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

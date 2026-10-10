import { assetURL, deleteJSON, getJSON, postJSON, postJSONBody, putJSONBody, sendJSONBody } from "@/lib/apiTransport";

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

export function mediaDownloadURL(locationId: number) {
  return assetURL(`/api/media/${locationId}/download`);
}

export const mediaApi = {
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
  getCacheOverview: () => getJSON<CacheOverview>("/api/cache/overview"),
  clearTranscodeCache: () => deleteJSON<TranscodeCacheClearResult>("/api/cache/transcodes"),
  cleanupCache: (payload: { mode: "orphans"; groupKeys: string[] } | { mode: "works"; workIds: number[] }) =>
    postJSONBody<CacheMaintenanceResult>("/api/cache/cleanup", payload),
  deleteMediaCacheLocation: (locationId: number) => deleteJSON<MediaCleanupResult>(`/api/media/${locationId}/cache`),
  deleteMediaLocalLocation: (locationId: number) => deleteJSON<MediaCleanupResult>(`/api/media/${locationId}/local`),
  cleanupMediaLocations: (targets: MediaCleanupTarget[], mode: MediaCleanupMode = "files_only") =>
    postJSONBody<MediaCleanupResult>("/api/media/cleanup", { targets, mode }),
  updateMediaProgress: (
    id: number,
    payload: { locationId: number; positionSeconds: number; durationSeconds: number | null; completed: boolean },
    signal?: AbortSignal,
  ) => sendJSONBody<MediaProgressUpdate>("PATCH", `/api/media-items/${id}/progress`, payload, { signal }),
};

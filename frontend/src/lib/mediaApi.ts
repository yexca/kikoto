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
  /** This viewer's lyrics timing offset in milliseconds; positive shows each line later. Absent means 0. */
  lyricsOffsetMs?: number;
  /** The first of `lyricsAssignments`: the library lyrics this viewer's playback uses. */
  assignedLyricsMediaItemId?: number | null;
  /**
   * The library-level lyrics files shared by every user unless they choose
   * another, one per language, in the order this viewer's playback tries them.
   */
  lyricsAssignments?: MediaLyricsAssignment[];
  locations: MediaFileLocation[];
};

/** A track's library lyrics file in one language; the empty language applies to every language. */
export type MediaLyricsAssignment = {
  language: string;
  lyricsMediaItemId: number;
};

export type LyricsAssignmentChange = {
  audioMediaItemId: number;
  /** The language the lyrics are in; empty applies to every language. */
  language: string;
  /** Null removes this language's lyrics, so playback falls back to another language or name matching. */
  lyricsMediaItemId: number | null;
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
  /**
   * The path with the display names the viewer's metadata languages give its
   * file and folders, segment for segment; only on a local location with such a name.
   */
  displayPath?: string;
  streamUrl: string;
  downloadUrl: string;
  remoteHash: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  availability: string;
  lastCheckedAt: string | null;
  /** The measured loudness of the file the location holds, once playback has measured it. */
  loudness?: MediaLoudness;
};

/** EBU R 128 integrated loudness and the peak level of one file. */
export type MediaLoudness = {
  integratedLufs: number;
  peakDbfs: number;
  /** "true" for a true peak, "sample" when only the sample peak could be measured. */
  peakKind: "true" | "sample";
};

/** A local file or folder of a work that a display name can name, with its names by metadata language. */
export type FileDisplayNameEntry = {
  /** Present for a file. */
  mediaItemId?: number;
  /** The file or folder below the work folder. */
  path: string;
  names: Record<string, string>;
};

export type FileDisplayNames = {
  workId: number;
  mediaWorkId: number;
  folders: FileDisplayNameEntry[];
  files: FileDisplayNameEntry[];
};

/** Names in one metadata language; an empty name removes that language's name. */
export type FileDisplayNamesChange = {
  language: string;
  files: { mediaItemId: number; name: string }[];
  folders: { path: string; name: string }[];
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

/** A local file that holds the same bytes as the other files of its group. */
export type DuplicateFile = {
  locationId: number;
  mediaItemId: number;
  workId: number;
  workCode: string;
  /** The file's path relative to the library. */
  path: string;
};

export type DuplicateFileGroup = {
  sizeBytes: number;
  files: DuplicateFile[];
};

export type DuplicateFilesResult = {
  /** False while files that could be identical are still unchecked; repeat the request to continue. */
  complete: boolean;
  checkedFiles: number;
  pendingFiles: number;
  pendingBytes: number;
  groups: DuplicateFileGroup[];
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
  /** Compares the local files of a work's family by content; one request does a bounded share of the work. */
  findWorkDuplicateFiles: (workId: number) =>
    postJSON<DuplicateFilesResult>(`/api/works/${workId}/local-files/duplicates`),
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
  /** Stores this viewer's lyrics timing offset; 0 removes it and the lyrics choice is kept. */
  setMediaLyricsOffset: (audioMediaItemId: number, lyricsOffsetMs: number) =>
    putJSONBody<{ audioMediaItemId: number; lyricsMediaItemId: number | null; lyricsOffsetMs: number }>(
      `/api/media/${audioMediaItemId}/lyrics-preference`,
      { lyricsOffsetMs },
    ),
  /** Returns a local location's loudness, measuring it on the server first when needed. */
  getMediaLoudness: (locationId: number, signal?: AbortSignal) =>
    getJSON<MediaLoudness>(`/api/media/${locationId}/loudness`, signal),
  setWorkLyricsAssignments: (workId: number, assignments: LyricsAssignmentChange[]) =>
    putJSONBody<{ workId: number; assignments: LyricsAssignmentChange[] }>(`/api/works/${workId}/lyrics-assignments`, {
      assignments,
    }),
  getWorkFileDisplayNames: (workId: number, signal?: AbortSignal) =>
    getJSON<FileDisplayNames>(`/api/works/${workId}/file-display-names`, signal),
  setWorkFileDisplayNames: (workId: number, change: FileDisplayNamesChange) =>
    putJSONBody<FileDisplayNames>(`/api/works/${workId}/file-display-names`, change),
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

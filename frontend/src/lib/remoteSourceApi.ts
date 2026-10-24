import { apiSessionVersion, assertApiSession } from "@/lib/apiSession";
import { deleteJSON, getJSON, postJSONBody } from "@/lib/apiTransport";
import type { LibrarySort, ListeningStatus, SortDirection, SourcePresenceItem, UserTag } from "@/lib/libraryApi";
import type { LocalFolderAvailability } from "@/lib/localAvailability";
import type { MediaCacheResult } from "@/lib/mediaApi";
import type { WorkMetadataPresentation } from "@/lib/metadataApi";

export type RemoteWorksResponse = {
  sourceId: number;
  works: RemoteWork[];
  page: number;
  pageSize: number;
  total: number;
  status: string;
  error?: {
    code: "disabled" | "unavailable" | string;
    message: string;
    url?: string;
    retryable: boolean;
  };
  sort: LibrarySort;
  direction: SortDirection;
  sortApplied: boolean;
  recommendationUnavailable?: boolean;
};

export type RemoteWork = {
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  title: string;
  releaseDate: string;
  updatedAt: string;
  coverUrl: string;
  circle: string;
  circleRef?: RemoteEntityRef;
  ageRating: string;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  hasLyrics?: boolean;
  price: number | null;
  tags: string[];
  voiceActors: string[];
  voiceRefs: RemoteEntityRef[];
  importStatus: string;
  remotePlayable: boolean;
  workId: number | null;
  favorite: boolean;
  listeningStatus: ListeningStatus;
  recommendScore: number;
  /** The work's state in this library, as a Library card shows it; empty for a work the library does not hold. */
  sourcePresence: SourcePresenceItem[];
  availability: string[];
  userTags: UserTag[];
  /** Every edition of the card's work family the source returned, the presented one included. */
  editions: RemoteWorkEdition[];
};

/** One upstream entry folded into a remote card; `language` is a metadata language token when known. */
export type RemoteWorkEdition = {
  remoteId: string;
  remoteCode: string;
  title: string;
  language: string;
  label: string;
  origin: boolean;
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
  remoteCode: string;
  title: string;
  coverUrl: string;
  sourceUrl: string;
  publicWorkUrl: string;
  circle: string;
  circleRef?: RemoteEntityRef;
  rating: number | null;
  ratingCount?: number | null;
  sales: number | null;
  price: number | null;
  ageRating: string;
  releaseDate: string;
  durationSeconds: number | null;
  tags: string[];
  voiceActors: string[];
  importStatus: string;
  workId: number | null;
  metadataPresentation: WorkMetadataPresentation;
  tracks: RemoteTrack[];
  languageEditions: RemoteLanguageEdition[];
};

export type RemoteWorkMetadata = Omit<RemoteWorkDetail, "tracks">;

export type RemoteWorkTracksResponse = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  remoteId: string;
  primaryCode: string;
  remoteCode: string;
  tracks: RemoteTrack[];
};

export type RemoteLanguageEdition = {
  remoteCode: string;
  language: string;
  label: string;
  displayOrder: number;
  current: boolean;
  origin: boolean;
};

export type SourceAvailabilitySource = {
  sourceId: number;
  sourceCode: string;
  displayName: string;
  status: "available" | "not_found" | "unavailable" | "disabled" | "error" | "unknown";
  remoteId: string;
  primaryCode: string;
  editionCode?: string;
  remoteCode?: string;
  title: string;
  coverUrl: string;
  workId: number | null;
  hasRemote: boolean;
  hasTracked: boolean;
  hasCache: boolean;
  hasLocal: boolean;
  error: string;
  elapsedMs: number;
};

export type SourceAvailabilityResponse = {
  workCode: string;
  checkedAt: string;
  sources: SourceAvailabilitySource[];
};

export type RemoteWorkSyncResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  tracked: boolean;
  syncedMediaItems: number;
  syncedLocations: number;
  triggerReason: string;
};

export type RemoteWorkTrackResult = {
  runId: number;
  jobId: number;
  workId: number | null;
  primaryCode: string;
  status: string;
  triggerReason: string;
  deduplicated: boolean;
};

export type RemoteWorkSaveSummary = {
  total: number;
  skipExisting: number;
  cacheHit: number;
  cacheDownload: number;
  promote: number;
  conflict: number;
};

export type RemoteWorkSavePlanItem = {
  itemKey: string;
  path: string;
  kind: string;
  sizeBytes: number | null;
  sourceKind: string;
  action: string;
  status: string;
  sourcePath: string;
  localSourcePath: string;
  cachePath: string;
  targetPath: string;
  mediaItemId: number;
  localPaths: string[];
  targetExists: boolean;
  targetConflict: boolean;
  targetConflictReason: string;
  /**
   * Why an existing entry blocks the target: a folder or other entry that is not
   * a file, which is never replaced, or a file where one of its folders belongs.
   */
  targetBlock?: "not_a_file" | "blocked_path";
  /** The blocking file's path below the edited folder, for a blocked path. */
  targetBlocker?: string;
  targetSizeBytes: number | null;
  originalTargetPath: string;
  resolution: RemoteFetchResolution;
  remoteSourceId: number;
  remoteSourceCode: string;
  remoteSourceName: string;
  remotePath: string;
  sourceOptions: RemoteFetchSourceOption[];
};

export type RemoteFetchResolution = "auto" | "keep_local" | "replace" | "keep_both" | "rename" | "exclude";

export type RemoteFetchFileDecision = {
  itemKey: string;
  sourceId: number;
  resolution: RemoteFetchResolution;
  targetPath: string;
};

export type RemoteFetchSourceOption = {
  sourceId: number;
  sourceCode: string;
  sourceName: string;
  path: string;
  sizeBytes: number | null;
};

export type RemoteWorkSaveLocalFile = {
  mediaItemId: number;
  path: string;
  sizeBytes: number | null;
  available: boolean;
};

export type RemoteFetchRootReview = {
  rootPath: string;
  status: "not_applicable" | "ready" | "managed" | "legacy_managed" | "conflict";
  conflict: boolean;
  message: string;
};

export type RemoteWorkSavePlan = {
  sourceId: number;
  primaryCode: string;
  editionCode?: string;
  remoteCode?: string;
  saveRoot: string;
  fetchRoot: RemoteFetchRootReview;
  localFiles: RemoteWorkSaveLocalFile[];
  items: RemoteWorkSavePlanItem[];
  summary: RemoteWorkSaveSummary;
  preparation: RemoteFetchPreparation;
};

export type RemoteFetchPreparation = {
  requestedCode: string;
  canonicalCode: string;
  metadataStatus: "complete" | "partial" | "degraded";
  warnings: string[];
  editions: RemoteFetchEdition[];
};

export type RemoteFetchEdition = {
  workId: number;
  primaryCode: string;
  title: string;
  metadataLanguage: string;
  editionLabel: string;
  translationKind: "origin" | "official" | "community" | "third_party" | "unknown";
  classificationSource: string;
  makerId: string;
  originMakerId: string;
  origin: boolean;
  localRoots: RemoteFetchLocalRoot[];
  sources: SourceAvailabilitySource[];
};

export type RemoteFetchLocalRoot = {
  id: number;
  fileSourceId: number;
  rootPath: string;
  role: "managed_fetch" | "external" | "alternate";
  state: "active" | "pending_cleanup" | "ignored";
  /** "offline" while the folder's storage pool is offline. */
  availability: LocalFolderAvailability;
  primary: boolean;
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
  cachedFiles: number;
  promotedFiles: number;
  plan: RemoteWorkSaveSummary;
  requestId: string;
  deduplicated: boolean;
};

export type WorkSourceUntrackResult = {
  workId: number;
  sourceId: number;
  status: string;
  clearedCaches: number;
  deletedFiles: number;
  trackedCleared: boolean;
  workPreserved: boolean;
  localPreserved: boolean;
};

export type RemoteTrackRunStatus = {
  runId: number;
  status: string;
  summaryJson: string;
};

export type RemoteEntityRef = {
  sourceId: number;
  externalId: string;
  name: string;
};

export const DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export const remoteSourceApi = {
  getRemoteTrackRunStatus: (id: number) => getJSON<RemoteTrackRunStatus>(`/api/remote-track-runs/${id}`),
  listRemoteSourceWorks: (
    id: number,
    page = 1,
    pageSize = 24,
    query = "",
    sort: LibrarySort = "recent",
    direction: SortDirection = "desc",
    seed = 1,
    recommendBadges = false,
    signal?: AbortSignal,
    recommendationSession = "",
  ) =>
    getJSON<RemoteWorksResponse>(
      `/api/remote-sources/${id}/works?page=${page}&pageSize=${pageSize}&sort=${encodeURIComponent(sort)}&direction=${encodeURIComponent(direction)}&seed=${seed}&recommendBadges=${recommendBadges}${query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ""}${recommendationSession ? `&recommendationSession=${encodeURIComponent(recommendationSession)}` : ""}`,
      signal,
    ),
  scoreRemoteRecommendations: (
    id: number,
    payload: {
      recommendationSession: string;
      works: Array<Pick<RemoteWork, "primaryCode" | "workId" | "tags" | "voiceActors" | "circle">>;
    },
    signal?: AbortSignal,
  ) =>
    postJSONBody<{ scores: Array<{ primaryCode: string; score: number }> }>(
      `/api/remote-sources/${id}/recommendations`,
      payload,
      signal,
    ),
  getRemoteSourceWorkMetadata: (id: number, code: string, signal?: AbortSignal) =>
    getJSON<RemoteWorkMetadata>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}`, signal),
  getRemoteSourceWorkTracks: (id: number, code: string, signal?: AbortSignal) =>
    getJSON<RemoteWorkTracksResponse>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/tracks`, signal),
  getRemoteSourceWork: async (id: number, code: string, signal?: AbortSignal) => {
    const version = apiSessionVersion();
    const metadata = await getJSON<RemoteWorkMetadata>(
      `/api/remote-sources/${id}/works/${encodeURIComponent(code)}`,
      signal,
    );
    assertApiSession(version);
    const tracks = await getJSON<RemoteWorkTracksResponse>(
      `/api/remote-sources/${id}/works/${encodeURIComponent(metadata.remoteCode || code)}/tracks`,
      signal,
    );
    assertApiSession(version);
    return { ...metadata, tracks: tracks.tracks };
  },
  getSourceAvailability: (code: string) =>
    getJSON<SourceAvailabilityResponse>(`/api/works/${encodeURIComponent(code)}/source-availability`),
  checkSourceAvailability: (code: string, sourceId = 0) =>
    postJSONBody<SourceAvailabilityResponse>(`/api/works/${encodeURIComponent(code)}/source-availability`, {
      sourceId,
    }),
  planRemoteSourceWorkSave: (
    id: number,
    code: string,
    paths: string[],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSavePlan>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch-plan`, {
      paths,
      minFreeBytes,
    }),
  saveRemoteSourceWork: (
    id: number,
    code: string,
    paths: string[],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
  ) =>
    postJSONBody<RemoteWorkSaveResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch`, {
      paths,
      minFreeBytes,
    }),
  planRemoteSourceWorkFetch: (
    id: number,
    code: string,
    paths: string[],
    localPaths: string[] = [],
    targetRoot = "",
    decisions: RemoteFetchFileDecision[] = [],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
    editionCode = "",
  ) =>
    postJSONBody<RemoteWorkSavePlan>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch-plan`, {
      paths,
      localPaths,
      targetRoot,
      decisions,
      minFreeBytes,
      ...(editionCode ? { editionCode } : {}),
    }),
  fetchRemoteSourceWork: (
    id: number,
    code: string,
    paths: string[],
    localPaths: string[] = [],
    requestId = "",
    targetRoot = "",
    decisions: RemoteFetchFileDecision[] = [],
    minFreeBytes = DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
    editionCode = "",
  ) =>
    postJSONBody<RemoteWorkSaveResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/fetch`, {
      paths,
      localPaths,
      requestId,
      targetRoot,
      decisions,
      minFreeBytes,
      ...(editionCode ? { editionCode } : {}),
    }),
  trackRemoteSourceWork: (id: number, code: string, triggerReason: string) =>
    postJSONBody<RemoteWorkTrackResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/track`, {
      triggerReason,
    }),
  syncRemoteSourceWork: (id: number, code: string, triggerReason: string) =>
    postJSONBody<RemoteWorkSyncResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/sync`, {
      triggerReason,
    }),
  untrackWorkSource: (workId: number, sourceId: number) =>
    deleteJSON<WorkSourceUntrackResult>(`/api/works/${workId}/tracked-sources/${sourceId}`),
  cacheRemoteSourceWorkMedia: (id: number, code: string, path: string) =>
    postJSONBody<MediaCacheResult>(`/api/remote-sources/${id}/works/${encodeURIComponent(code)}/cache`, { path }),
};

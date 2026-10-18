import { getJSON, postJSONBody } from "@/lib/apiTransport";
import type {
  RemoteFetchEdition,
  RemoteFetchFileDecision,
  RemoteWorkSavePlan,
  RemoteWorkSavePlanItem,
  RemoteWorkSaveResult,
} from "@/lib/remoteSourceApi";

/**
 * A file to add to the edited folder: from another local folder of the family, or from a remote edition.
 * With a `language`, a lyrics text file goes to that language's folder inside Kikoto's lyrics folder;
 * the empty language is the fallback lyrics.
 */
export type WorkFolderEditAddition = (
  | { kind: "local"; folderId: number; path: string }
  | { kind: "remote"; sourceId: number; remoteCode: string; path: string }
) & { language?: string };

/**
 * An added lyrics file, by its item key, as the library lyrics of an audio file: a media item of the
 * work, or a path below the folder for audio that is indexed only once the files are in place.
 */
export type WorkFolderEditAssignment =
  { audioMediaItemId: number; itemKey: string } | { audioPath: string; itemKey: string };

export type WorkFolderEditRequest = {
  folderId: number;
  additions: WorkFolderEditAddition[];
  removeLocationIds: number[];
  decisions: RemoteFetchFileDecision[];
  assignments?: WorkFolderEditAssignment[];
  requestId?: string;
};

export type WorkFolderEditItem = RemoteWorkSavePlanItem & {
  sourceFolderId?: number;
  remoteCode?: string;
  /** Present for a file added as lyrics of that language. */
  language?: string;
};

export type WorkFolderEditRemoval = {
  locationId: number;
  path: string;
  sizeBytes: number | null;
};

export type WorkFolderEditSummary = {
  add: number;
  copy: number;
  download: number;
  skip: number;
  conflict: number;
  remove: number;
  /** Added files that go to a lyrics folder. */
  lyrics: number;
  addBytes: number;
  removeBytes: number;
};

export type WorkFolderEditPlan = {
  workId: number;
  primaryCode: string;
  folderId: number;
  /** The edited folder, relative to the data root. */
  saveRoot: string;
  items: WorkFolderEditItem[];
  removals: WorkFolderEditRemoval[];
  summary: WorkFolderEditSummary;
};

/** Where files for a folder of the work can come from: its family's local folders and remote editions. */
export type WorkFolderEditSources = {
  workId: number;
  primaryCode: string;
  editions: RemoteFetchEdition[];
  warnings: string[];
};

export type WorkFolderEditResult = {
  runId: number;
  jobId: number;
  workId: number;
  primaryCode: string;
  status: string;
  saveRoot: string;
  plan: WorkFolderEditSummary;
  requestId: string;
};

/**
 * What a Fetch into a new folder adds to the folder once it is published: files of other editions,
 * sources, and local folders, and lyrics of a declared language.
 */
export type RemoteFetchFollowUp = {
  additions: WorkFolderEditAddition[];
  decisions: RemoteFetchFileDecision[];
  assignments?: WorkFolderEditAssignment[];
};

/** A Fetch of an edition's files into a new folder, with what to add to the folder afterwards. */
export type ComposedFetchRequest = {
  /** The library edition the fetched files must resolve to; empty accepts the one the source names. */
  editionCode?: string;
  paths: string[];
  decisions: RemoteFetchFileDecision[];
  followUp?: RemoteFetchFollowUp;
  requestId?: string;
  targetRoot?: string;
  minFreeBytes: number;
};

export type ComposedFetchPlan = RemoteWorkSavePlan & { followUp?: WorkFolderEditPlan };

export const workFolderEditApi = {
  getWorkFolderEditSources: (workId: number, signal?: AbortSignal) =>
    getJSON<WorkFolderEditSources>(`/api/works/${workId}/folder-edit/sources`, signal),
  /** Asks every remote source about each family edition, then lists the sources with the answers. */
  checkWorkFolderEditSources: (workId: number, signal?: AbortSignal) =>
    postJSONBody<WorkFolderEditSources>(`/api/works/${workId}/folder-edit/sources/check`, {}, signal),
  planWorkFolderEdit: (workId: number, request: WorkFolderEditRequest) =>
    postJSONBody<WorkFolderEditPlan>(`/api/works/${workId}/folder-edit/plan`, request),
  applyWorkFolderEdit: (workId: number, request: WorkFolderEditRequest) =>
    postJSONBody<WorkFolderEditResult>(`/api/works/${workId}/folder-edit`, request),
  planComposedFetch: (sourceId: number, remoteCode: string, request: ComposedFetchRequest) =>
    postJSONBody<ComposedFetchPlan>(
      `/api/remote-sources/${sourceId}/works/${encodeURIComponent(remoteCode)}/fetch-plan`,
      request,
    ),
  applyComposedFetch: (sourceId: number, remoteCode: string, request: ComposedFetchRequest) =>
    postJSONBody<RemoteWorkSaveResult>(
      `/api/remote-sources/${sourceId}/works/${encodeURIComponent(remoteCode)}/fetch`,
      request,
    ),
};

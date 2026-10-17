import { getJSON, postJSONBody } from "@/lib/apiTransport";
import type { RemoteFetchEdition, RemoteFetchFileDecision, RemoteWorkSavePlanItem } from "@/lib/remoteSourceApi";

/** A file to add to the edited folder: from another local folder of the family, or from a remote edition. */
export type WorkFolderEditAddition =
  | { kind: "local"; folderId: number; path: string }
  | { kind: "remote"; sourceId: number; remoteCode: string; path: string };

export type WorkFolderEditRequest = {
  folderId: number;
  additions: WorkFolderEditAddition[];
  removeLocationIds: number[];
  decisions: RemoteFetchFileDecision[];
  requestId?: string;
};

export type WorkFolderEditItem = RemoteWorkSavePlanItem & {
  sourceFolderId?: number;
  remoteCode?: string;
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
};

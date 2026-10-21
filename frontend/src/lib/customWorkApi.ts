import { getJSON, postJSONBody } from "@/lib/apiTransport";

/** A library folder that can become a custom work; the path is relative to the data root. */
export type CustomWorkFolder = {
  path: string;
  name: string;
  /** Fetch writes into the folder, so creation refuses it until Fetch is done with it. */
  inUse: boolean;
};

export type CustomWorkFolderList = {
  folders: CustomWorkFolder[];
  /** More folders match than one listing returns; a narrower search finds them. */
  truncated: boolean;
  /** Whether an administrator accepted the notice that creating a custom work renames its folder. */
  noticeAccepted: boolean;
};

/**
 * One folder of the custom work folder tree. A folder that cannot become a
 * custom work is shown when folders that can lie below it.
 */
export type CustomWorkTreeFolder = {
  path: string;
  name: string;
  selectable: boolean;
  hasChildren: boolean;
  reason?: "holds_works" | "in_use" | "storage_pool";
};

export type CustomWorkTree = {
  path: string;
  folders: CustomWorkTreeFolder[];
  /** The folder holds more folders than one level returns. */
  truncated: boolean;
};

export type CustomWorkCreated = {
  workId: number;
  code: string;
  /** The renamed folder, relative to the data root. */
  path: string;
  scanRunId?: number;
};

export const customWorkApi = {
  listCustomWorkFolders: (query: string, signal?: AbortSignal) =>
    getJSON<CustomWorkFolderList>(`/api/custom-works/folders?${new URLSearchParams({ q: query.trim() })}`, signal),
  getCustomWorkFolder: (path: string, signal?: AbortSignal) =>
    getJSON<CustomWorkFolder>(`/api/custom-works/folder?${new URLSearchParams({ path: path.trim() })}`, signal),
  listCustomWorkTree: (path: string, signal?: AbortSignal) =>
    getJSON<CustomWorkTree>(`/api/custom-works/tree?${new URLSearchParams({ path })}`, signal),
  createCustomWork: (request: { path: string; title: string }) =>
    postJSONBody<CustomWorkCreated>("/api/custom-works", request),
  getCustomWorkNotice: (signal?: AbortSignal) =>
    getJSON<{ noticeAccepted: boolean }>("/api/custom-works/notice-acceptance", signal),
  acceptCustomWorkNotice: () => postJSONBody<{ noticeAccepted: boolean }>("/api/custom-works/notice-acceptance", {}),
};

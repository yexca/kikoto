import { getJSON, postJSONBody } from "@/lib/apiTransport";

/** A library folder that can become a custom work; the path is relative to the data root. */
export type CustomWorkFolder = {
  path: string;
  name: string;
};

export type CustomWorkFolderList = {
  folders: CustomWorkFolder[];
  /** More folders match than one listing returns; a narrower search finds them. */
  truncated: boolean;
  /** Whether an administrator accepted the notice that creating a custom work renames its folder. */
  noticeAccepted: boolean;
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
  createCustomWork: (request: { path: string; title: string }) =>
    postJSONBody<CustomWorkCreated>("/api/custom-works", request),
  acceptCustomWorkNotice: () => postJSONBody<{ noticeAccepted: boolean }>("/api/custom-works/notice-acceptance", {}),
};

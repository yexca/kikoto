import { postJSONBody } from "@/lib/apiTransport";
import type { RemoteFetchFileDecision, RemoteWorkSavePlanItem } from "@/lib/remoteSourceApi";
import type { FolderLyricsMode } from "@/lib/settingsApi";
import type { WorkFolderEditRemoval } from "@/lib/workFolderEditApi";

/**
 * A lyrics file to bring into a language's lyrics folder of the edited folder:
 * a file of that folder itself, a file of another local folder of the family,
 * or a file a remote edition offers. The language is the one the lyrics are
 * in; empty applies to every language.
 */
export type LyricsEditAddition =
  | { kind: "folder"; path: string; language: string }
  | { kind: "local"; folderId: number; path: string; language: string }
  | { kind: "remote"; sourceId: number; remoteCode: string; path: string; language: string };

export type LyricsEditRequest = {
  folderId: number;
  additions: LyricsEditAddition[];
  /** Local locations of the managed lyrics to delete. */
  removeLocationIds: number[];
  decisions: RemoteFetchFileDecision[];
  /** Added files to assign as the library lyrics of local tracks, in the file's language. */
  assignments: { audioMediaItemId: number; itemKey: string }[];
  /**
   * Copies or moves the added files of the edited folder that are outside
   * Kikoto's lyrics folder; managed lyrics that change language always move.
   */
  folderMode: FolderLyricsMode;
};

export type LyricsEditItem = RemoteWorkSavePlanItem & {
  language: string;
  sourceFolderId?: number;
  remoteCode?: string;
};

export type LyricsEditSummary = {
  add: number;
  move: number;
  copy: number;
  download: number;
  skip: number;
  conflict: number;
  remove: number;
};

export type LyricsEditPlan = {
  workId: number;
  folderId: number;
  folderMode: FolderLyricsMode;
  /** The edited folder, relative to the data root. */
  saveRoot: string;
  items: LyricsEditItem[];
  removals: WorkFolderEditRemoval[];
  summary: LyricsEditSummary;
};

export type LyricsEditResult = {
  workId: number;
  saveRoot: string;
  moved: number;
  copied: number;
  downloaded: number;
  removed: number;
  /** Files the folder already held with the same content. */
  skipped: number;
  assigned: number;
};

export const lyricsEditApi = {
  planWorkLyricsEdit: (workId: number, request: LyricsEditRequest) =>
    postJSONBody<LyricsEditPlan>(`/api/works/${workId}/lyrics-edit/plan`, request),
  applyWorkLyricsEdit: (workId: number, request: LyricsEditRequest) =>
    postJSONBody<LyricsEditResult>(`/api/works/${workId}/lyrics-edit`, request),
};

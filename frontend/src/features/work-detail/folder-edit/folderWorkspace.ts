import { useCallback, useMemo, useRef, useState } from "react";

import {
  localFolderFiles,
  remoteEditionFiles,
  withFolderEditPaths,
  withLyricsRole,
  type FolderEditFile,
  type FolderEditLyricsRoles,
  type FolderEditReadiness,
  type FolderEditResource,
  type FolderEditResultEntry,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { api, type RemoteFetchFileDecision } from "@/lib/api";

export type FolderEditFilesState = {
  status: "loading" | "ready" | "error";
  files: FolderEditFile[];
};

/**
 * What the three-column folder workspace shows and changes, for an edit of an
 * existing folder and for a Fetch into a new one alike.
 */
export type FolderWorkspace = {
  resources: FolderEditResource[];
  sourcesStatus: "loading" | "ready" | "error";
  retrySources: () => void;
  /** Present where the remote sources can be asked again about every edition. */
  remoteCheck?: { checking: boolean; check: () => void };
  files: Readonly<Record<string, FolderEditFilesState>>;
  selection: Readonly<Record<string, ReadonlySet<string>>>;
  lyrics: FolderEditLyricsRoles;
  activeResource: FolderEditResource;
  selectResource: (resource: FolderEditResource) => void;
  retryResource: (resource: FolderEditResource) => void;
  setSelected: (resourceId: string, paths: ReadonlySet<string>) => void;
  /** Adds the files as lyrics of a language, or as plain files for `null`. */
  setLyricsRole: (resourceId: string, paths: readonly string[], language: string | null) => void;
  decisions: Readonly<Record<string, RemoteFetchFileDecision>>;
  setDecision: (decision: RemoteFetchFileDecision) => void;
  /** How many selected files the change brings in, and how many of them as lyrics. */
  additionCount: number;
  lyricsAdditionCount: number;
  /** The folder the change writes, relative to the data root; empty until a new folder is planned. */
  rootPath: string;
  result: FolderEditResultEntry[];
  readiness: FolderEditReadiness;
  addCount: number;
  removeCount: number;
  conflictCount: number;
  planFailed: boolean;
  retryPlan: () => void;
  /** Whether added lyrics may be assigned to tracks, whether they will be, and to how many. */
  canAssign: boolean;
  assign: boolean;
  setAssign: (assign: boolean) => void;
  assignmentCount: number;
  applying: boolean;
};

const noFiles: FolderEditFile[] = [];

/**
 * The files of every place a workspace reads from, which of them are
 * selected, and which are added as lyrics. A place's files load when it is
 * first opened.
 */
export function useFolderWorkspaceFiles() {
  const [files, setFiles] = useState<Record<string, FolderEditFilesState>>({});
  const [selection, setSelection] = useState<Record<string, ReadonlySet<string>>>({});
  const [lyrics, setLyrics] = useState<Record<string, Readonly<Record<string, string>>>>({});
  const loading = useRef(new Set<string>());

  const loadResource = useCallback(async (resource: FolderEditResource): Promise<FolderEditFile[] | null> => {
    if (resource.kind === "current" || loading.current.has(resource.id)) return null;
    loading.current.add(resource.id);
    setFiles((current) => ({ ...current, [resource.id]: { status: "loading", files: noFiles } }));
    try {
      const loaded =
        resource.kind === "local"
          ? localFolderFiles((await api.getWork(resource.workId)).mediaItems, resource.rootPath)
          : remoteEditionFiles(
              (await api.getRemoteSourceWork(resource.sourceId, resource.remoteCode ?? resource.editionCode)).tracks,
            );
      setFiles((current) => ({ ...current, [resource.id]: { status: "ready", files: loaded } }));
      return loaded;
    } catch {
      setFiles((current) => ({ ...current, [resource.id]: { status: "error", files: noFiles } }));
      return null;
    } finally {
      loading.current.delete(resource.id);
    }
  }, []);

  const readyFiles = useMemo(() => {
    const ready: Record<string, FolderEditFile[]> = {};
    for (const [id, state] of Object.entries(files)) if (state.status === "ready") ready[id] = state.files;
    return ready;
  }, [files]);

  const setSelected = useCallback(
    (resourceId: string, paths: ReadonlySet<string>) =>
      setSelection((current) => ({ ...current, [resourceId]: paths })),
    [],
  );

  // Choosing a lyrics language for a file also selects it.
  const setLyricsRole = useCallback((resourceId: string, paths: readonly string[], language: string | null) => {
    setLyrics((current) => ({ ...current, [resourceId]: withLyricsRole(current[resourceId], paths, language) }));
    if (language !== null) {
      setSelection((current) => ({
        ...current,
        [resourceId]: withFolderEditPaths(current[resourceId] ?? new Set(), paths, true),
      }));
    }
  }, []);

  return { files, setFiles, selection, setSelection, setSelected, lyrics, setLyricsRole, loadResource, readyFiles };
}

export function createFolderWorkspaceRequestId(prefix: string) {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

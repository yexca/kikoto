import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

import type { PendingDeletion, PendingDeletions } from "@/features/work-detail/folder-edit/fileWorkspaceModel";
import {
  folderEditCollision,
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
import {
  addFolder,
  deleteFolder,
  folderContains,
  folderNameError,
  holdsLyricsFolder,
  moveFilesTo,
  moveFolderTo,
  placeFilesBelow,
  renameFolder,
  type FolderEditLayout,
  type FolderEditNameError,
  type FolderEditPlaced,
} from "@/features/work-detail/folder-edit/folderEditLayout";
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
  /** Set for a custom work, which no remote source has: only local places are listed. */
  localOnly?: boolean;
  files: Readonly<Record<string, FolderEditFilesState>>;
  selection: Readonly<Record<string, ReadonlySet<string>>>;
  lyrics: FolderEditLyricsRoles;
  activeResource: FolderEditResource;
  selectResource: (resource: FolderEditResource) => void;
  /** Loads a place's files for a pane that shows it, without making it the active place. */
  openResource: (resource: FolderEditResource) => void;
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
  /** Present where the final folder's files and folders can be arranged. */
  arrange?: FolderWorkspaceArrange;
  /** Present where local places can be merged into the final folder. */
  merge?: FolderWorkspaceMerge;
  /** Present where every change of the edit can be undone at once, and the undo taken back. */
  undo?: {
    canUndo: boolean;
    undoAll: () => void;
    /** The last undo can still be taken back: nothing changed since. */
    canRestore: boolean;
    restore: () => void;
  };
};

/**
 * What Manage files adds to the workspace: a toolbar for the whole folder,
 * tools and notes for the edited folder's files, and everything the edit
 * deletes, which each file's menu can add to or take from.
 */
export type FolderWorkspaceManage = {
  toolbar?: ReactNode;
  /** Shown above the edited folder's files. */
  thisFolderTools?: ReactNode;
  /**
   * A note after a folder's name, by its path, in the edited folder and the
   * final folder, with the paths in the edited folder of the files it holds.
   */
  folderNote?: (path: string, files: readonly string[]) => ReactNode;
  /** Finding the edited folder's files that have an identical copy, when the viewer may. */
  identical?: FolderWorkspaceIdentical;
  pending: PendingDeletions;
  onKeep: (item: PendingDeletion) => void;
  /** Deletes a file of the edited folder, or drops a file the edit adds. */
  onDiscard: (entry: FolderEditResultEntry) => void;
};

/**
 * The edited folder's files that have an identical copy, and the parts that
 * find, mark, and review them.
 */
export type FolderWorkspaceIdentical = {
  /** Starts a check after saying what it does; it sits in This folder's head. */
  entry: ReactNode;
  /** The check's progress, or what it found with the way to the review. */
  status: ReactNode;
  /** Every set of identical files with the copy each keeps, once a check found some. */
  review: ReactNode | null;
  /** How many files of the edited folder have an identical copy. */
  count: number;
  /** The paths in the edited folder that have an identical copy. */
  paths: ReadonlySet<string>;
  /** A file's mark, by its path in the edited folder; `deleting` adds that the edit deletes it. */
  badge: (path: string, options?: { deleting?: boolean }) => ReactNode;
  /** Only the files with an identical copy are shown in the edited folder. */
  only: boolean;
  /** Changes with each finished check, so the edited folder opens the folders that hold identical files. */
  revision: number;
};

/** A file to bring into view, by the place that holds it and its path there. */
export type FolderWorkspaceRevealTarget = { resourceId: string; path: string };

/** A file a tree brings into view; `seq` changes with each request, also for the same file. */
export type FolderEditReveal = { path: string; seq: number };

/**
 * Moves between the workspace's views from inside them: to the review of
 * identical files, and to a file in the place that holds it. A layout that
 * cannot show a file in its place leaves `reveal` out.
 */
export type FolderWorkspaceNavigation = {
  showIdenticalReview?: () => void;
  reveal?: (target: FolderWorkspaceRevealTarget) => void;
};

export const FolderWorkspaceNavigationContext = createContext<FolderWorkspaceNavigation>({});

export function useFolderWorkspaceNavigation() {
  return useContext(FolderWorkspaceNavigationContext);
}

/** Arranges the final folder: moves its files and folders, and creates, renames, and deletes folders. */
export type FolderWorkspaceArrange = {
  /** The folders the user created. */
  folders: readonly string[];
  /** A path two files would share because one was placed there, which stops the change until one moves. */
  collision: string | null;
  /** Whether a created folder that ends up holding nothing is still created. */
  createsEmptyFolders: boolean;
  moveEntries: (keys: readonly string[], folder: string) => void;
  moveFolder: (folder: string, target: string) => void;
  folderNameError: (parent: string, name: string, self?: string) => FolderEditNameError | null;
  addFolder: (parent: string, name: string) => void;
  renameFolder: (folder: string, name: string) => void;
  deleteFolder: (folder: string) => void;
  /** Adds files of a place below a folder of the final folder, keeping their paths below `base`. */
  placeFromResource: (resource: FolderEditResource, paths: readonly string[], base: string, folder: string) => void;
};

/** The local places that are deleted once the final folder holds what it takes from them. */
export type FolderWorkspaceMerge = {
  folderIds: ReadonlySet<number>;
  setMerged: (resource: FolderEditResource, merged: boolean) => void;
};

/**
 * The arrange actions over a layout. `entries` is the final folder as it is
 * now; `include` selects files of a place as plain files at their own path,
 * and `forget` drops the conflict decisions an addition made at its earlier
 * path.
 */
export function folderWorkspaceArrange({
  layout,
  setLayout,
  entries,
  include,
  forget,
  keyFor,
  createsEmptyFolders = true,
}: {
  layout: FolderEditLayout;
  setLayout: (layout: FolderEditLayout) => void;
  entries: readonly FolderEditResultEntry[];
  include: (resource: FolderEditResource, paths: readonly string[]) => void;
  forget: (keys: readonly string[]) => void;
  keyFor: (resource: FolderEditResource, path: string) => string;
  createsEmptyFolders?: boolean;
}): FolderWorkspaceArrange {
  const placed: FolderEditPlaced[] = entries
    .filter((entry) => entry.state !== "remove" && entry.state !== "excluded" && entry.state !== "moved")
    .map((entry) => ({ key: entry.key, path: entry.path }));
  const movedAdditions = (keys: readonly string[]) => forget(keys.filter((key) => !key.startsWith("current:")));
  return {
    folders: layout.folders,
    collision: folderEditCollision(entries, layout.placements),
    createsEmptyFolders,
    moveEntries: (keys, folder) => {
      movedAdditions(keys);
      setLayout(moveFilesTo(layout, placed, keys, folder));
    },
    moveFolder: (folder, target) => {
      movedAdditions(placed.filter((file) => folderContains(folder, file.path)).map((file) => file.key));
      setLayout(moveFolderTo(layout, placed, folder, target));
    },
    folderNameError: (parent, name, self) => folderNameError(placed, layout.folders, parent, name, self),
    addFolder: (parent, name) => setLayout(addFolder(layout, parent, name)),
    renameFolder: (folder, name) => {
      movedAdditions(placed.filter((file) => folderContains(folder, file.path)).map((file) => file.key));
      setLayout(renameFolder(layout, placed, folder, name));
    },
    deleteFolder: (folder) => {
      movedAdditions(placed.filter((file) => folderContains(folder, file.path)).map((file) => file.key));
      setLayout(deleteFolder(layout, placed, folder));
    },
    placeFromResource: (resource, paths, base, folder) => {
      if (paths.length === 0 || holdsLyricsFolder(paths)) return;
      include(resource, paths);
      const prefix = base ? `${base}/` : "";
      const arriving = paths.map((path) => ({
        key: keyFor(resource, path),
        path: path.startsWith(prefix) ? path.slice(prefix.length) : path,
      }));
      movedAdditions(arriving.map((file) => file.key));
      setLayout(placeFilesBelow(layout, placed, arriving, folder));
    },
  };
}

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
  const loading = useRef(new Map<string, Promise<FolderEditFile[] | null>>());

  const loadResource = useCallback((resource: FolderEditResource): Promise<FolderEditFile[] | null> => {
    if (resource.kind === "current") return Promise.resolve(null);
    return sharedLoad(loading.current, resource.id, async () => {
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
      }
    });
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

  return {
    files,
    setFiles,
    selection,
    setSelection,
    setSelected,
    lyrics,
    setLyrics,
    setLyricsRole,
    loadResource,
    readyFiles,
  };
}

/**
 * Starts a load once per key: a caller that asks while the load is in flight,
 * such as an effect that React runs twice in development, awaits the same
 * load instead of getting nothing.
 */
export function sharedLoad<T>(inFlight: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = load().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

export function createFolderWorkspaceRequestId(prefix: string) {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${random}`;
}

import { useCallback, useEffect, useRef, useState } from "react";

import { api, type RecordAsset, type RecordFolder, type RecordRoot } from "@/lib/api";

import { applyRecordsNavigation } from "./useRecordsLocation";
import { crumbFromFolder, folderPathFromChildren } from "./recordsModel";
import { historyStateWithRecordTrail, recordTrailFromState, type RecordCrumb } from "./recordsLocation";

export type RecordRootState = { status: "loading" } | { status: "error" } | { status: "ready"; root: RecordRoot };

export type RecordTreeState =
  | { status: "idle" }
  | { status: "loading"; folderId: number }
  | { status: "error"; folderId: number }
  | { status: "ready"; folderId: number; folders: RecordFolder[]; assets: RecordAsset[] };

/** The root state, read once and again on Retry or while a scan runs. */
export function useRecordRoot(enabled: boolean) {
  const [state, setState] = useState<RecordRootState>({ status: "loading" });
  const reload = useCallback(async () => {
    try {
      const result = await api.getRecordRoot();
      setState({ status: "ready", root: result.root });
      return result.root;
    } catch {
      setState((current) => (current.status === "ready" ? current : { status: "error" }));
      return null;
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { state, reload, setRoot: (root: RecordRoot) => setState({ status: "ready", root }) };
}

/**
 * Walks from the root to a folder by name to recover a pasted link's
 * breadcrumb. Each step reads its listing page by page until the name turns
 * up; subfolders come first, so the walk stops at the first page of files. A
 * step that no longer matches stops the walk.
 */
async function recoverTrail(folderId: number, path: readonly string[], signal: AbortSignal) {
  const trail: RecordCrumb[] = [];
  let parent = 0;
  for (const name of path) {
    let folder: RecordFolder | undefined;
    let offset: number | undefined = 0;
    while (!folder && offset !== undefined) {
      const listing = await api.listRecordTree(parent || undefined, signal, offset);
      folder = listing.folders.find((candidate) => candidate.name === name);
      offset = listing.assets.length === 0 ? listing.nextOffset : undefined;
    }
    if (!folder) return null;
    trail.push(crumbFromFolder(folder));
    parent = folder.id;
  }
  return parent === folderId ? trail : null;
}

/** Appends a page to a listing, leaving out children an earlier page already held. */
function appendById<T extends { id: number }>(listed: readonly T[], page: readonly T[]) {
  const seen = new Set(listed.map((item) => item.id));
  return [...listed, ...page.filter((item) => !seen.has(item.id))];
}

/**
 * The open folder's listing and breadcrumb trail. The listing arrives a page
 * at a time and is read to its end: a first visit shows each page as it
 * arrives, while a refresh keeps the current listing until the new one is
 * whole. The trail comes from the history entry; a pasted or bookmarked link
 * recovers it from the listing's relative paths and stores it on the entry.
 */
export function useRecordTree(folderId: number, historyState: unknown, enabled: boolean) {
  const [tree, setTree] = useState<RecordTreeState>({ status: "idle" });
  const [recoveredTrail, setRecoveredTrail] = useState<{ folderId: number; trail: RecordCrumb[] | null } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(false);
  // The folder whose whole listing is on screen.
  const listedFolderRef = useRef<number | null>(null);
  const storedTrail = recordTrailFromState(historyState, folderId);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const refreshing = listedFolderRef.current === folderId;
    if (!refreshing) listedFolderRef.current = null;
    setPending(true);
    setTree((current) =>
      current.status === "ready" && current.folderId === folderId ? current : { status: "loading", folderId },
    );
    const recover = async (folders: RecordFolder[], assets: RecordAsset[]) => {
      if (recordTrailFromState(window.history.state, folderId) !== null) return;
      const path = folderPathFromChildren(folders, assets);
      const trail = path ? await recoverTrail(folderId, path, signal).catch(() => null) : null;
      if (signal.aborted) return;
      setRecoveredTrail({ folderId, trail });
      if (trail) {
        applyRecordsNavigation({
          mode: "replace",
          href: `${window.location.pathname}${window.location.search}`,
          state: historyStateWithRecordTrail(window.history.state, trail),
        });
      }
    };
    const load = async () => {
      let folders: RecordFolder[] = [];
      let assets: RecordAsset[] = [];
      let offset: number | undefined = 0;
      let first = true;
      while (offset !== undefined) {
        const page = await api.listRecordTree(folderId || undefined, signal, offset);
        if (signal.aborted) return;
        folders = appendById(folders, page.folders);
        assets = appendById(assets, page.assets);
        offset = page.nextOffset;
        if (!refreshing || offset === undefined) setTree({ status: "ready", folderId, folders, assets });
        if (first) {
          first = false;
          await recover(folders, assets);
          if (signal.aborted) return;
        }
      }
      listedFolderRef.current = folderId;
    };
    void load()
      .catch(() => {
        if (!controller.signal.aborted) setTree({ status: "error", folderId });
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [enabled, folderId, reloadToken]);

  const trail =
    storedTrail ??
    (recoveredTrail?.folderId === folderId ? recoveredTrail.trail : null) ??
    // Until the trail is known, or for an empty folder whose path cannot be read, the folder stands alone.
    (folderId > 0 ? [{ id: folderId, name: "" }] : []);

  return { tree, trail, pending, reload: () => setReloadToken((value) => value + 1) };
}

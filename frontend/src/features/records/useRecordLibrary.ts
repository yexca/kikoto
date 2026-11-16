import { useCallback, useEffect, useState } from "react";

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
 * breadcrumb. Each step reads one listing, and a step that no longer matches
 * stops the walk.
 */
async function recoverTrail(folderId: number, path: readonly string[], signal: AbortSignal) {
  const trail: RecordCrumb[] = [];
  let parent = 0;
  for (const name of path) {
    const listing = await api.listRecordTree(parent || undefined, signal);
    const folder = listing.folders.find((candidate) => candidate.name === name);
    if (!folder) return null;
    trail.push(crumbFromFolder(folder));
    parent = folder.id;
  }
  return parent === folderId ? trail : null;
}

/**
 * The open folder's listing and breadcrumb trail. The trail comes from the
 * history entry; a pasted or bookmarked link recovers it from the listing's
 * relative paths and stores it on the entry.
 */
export function useRecordTree(folderId: number, historyState: unknown, enabled: boolean) {
  const [tree, setTree] = useState<RecordTreeState>({ status: "idle" });
  const [recoveredTrail, setRecoveredTrail] = useState<{ folderId: number; trail: RecordCrumb[] | null } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState(false);
  const storedTrail = recordTrailFromState(historyState, folderId);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setPending(true);
    setTree((current) =>
      current.status === "ready" && current.folderId === folderId ? current : { status: "loading", folderId },
    );
    void api
      .listRecordTree(folderId || undefined, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setTree({ status: "ready", folderId, folders: result.folders, assets: result.assets });
        if (recordTrailFromState(window.history.state, folderId) !== null) return;
        const path = folderPathFromChildren(result.folders, result.assets);
        const trail = path ? await recoverTrail(folderId, path, controller.signal).catch(() => null) : null;
        if (controller.signal.aborted) return;
        setRecoveredTrail({ folderId, trail });
        if (trail) {
          applyRecordsNavigation({
            mode: "replace",
            href: `${window.location.pathname}${window.location.search}`,
            state: historyStateWithRecordTrail(window.history.state, trail),
          });
        }
      })
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

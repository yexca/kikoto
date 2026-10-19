import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  emptyFolderEditLayout,
  prunedLayout,
  type FolderEditLayout,
} from "@/features/work-detail/folder-edit/folderEditLayout";
import {
  CURRENT_FOLDER_RESOURCE,
  folderEditCanMerge,
  folderEditItemKey,
  folderEditMerges,
  folderEditNeedsPlan,
  folderEditPlacementKeys,
  folderEditReadiness,
  folderEditRemoteResource,
  folderEditRequest,
  folderEditResourceItemKey,
  folderEditResources,
  folderEditResult,
  localFolderFiles,
  withFolderEditPaths,
  type FolderEditPendingAddition,
  type FolderEditResource,
  type FolderEditTarget,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { folderEditAssignments } from "@/features/work-detail/folder-edit/folderEditLyrics";
import {
  createFolderWorkspaceRequestId,
  folderWorkspaceArrange,
  useFolderWorkspaceFiles,
  type FolderWorkspace,
} from "@/features/work-detail/folder-edit/folderWorkspace";
import { folderAudio } from "@/features/work-detail/lyrics/lyricsEditModel";
import {
  ApiError,
  api,
  type MediaItem,
  type RemoteFetchFileDecision,
  type WorkFolderEditPlan,
  type WorkFolderEditRequest,
  type WorkFolderEditResult,
} from "@/lib/api";

export type { FolderEditFilesState } from "@/features/work-detail/folder-edit/folderWorkspace";

/** The remote edition a Fetch opens the workspace on. */
export type FolderEditInitialRemote = {
  sourceId: number;
  remoteCode: string;
};

const PLAN_DELAY_MS = 500;
const noSelection: ReadonlySet<string> = new Set();

/**
 * The state of one folder edit: where files can come from, what is selected in
 * each place and which files are added as lyrics, the server's preview of the
 * additions, and the submission.
 */
export function useFolderEditWorkspace({
  target,
  currentItems,
  initialRemote,
  canAssign,
  localOnly = false,
  onApplied,
}: {
  target: FolderEditTarget;
  /** The media of the edited work, which the page has already loaded. */
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  /** Whether the viewer may assign added lyrics to tracks. */
  canAssign: boolean;
  /** Lists only local places, for a custom work that no remote source has. */
  localOnly?: boolean;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const currentFiles = useMemo(() => localFolderFiles(currentItems, target.rootPath), [currentItems, target.rootPath]);
  const currentResource = useMemo<FolderEditResource>(
    () => folderEditResources({ workId: target.workId, primaryCode: "", editions: [], warnings: [] }, target)[0],
    [target],
  );
  const [resources, setResources] = useState<FolderEditResource[]>([currentResource]);
  const [sourcesStatus, setSourcesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sourcesAttempt, setSourcesAttempt] = useState(0);
  const { files, setFiles, selection, setSelection, setSelected, lyrics, setLyricsRole, loadResource, readyFiles } =
    useFolderWorkspaceFiles();
  const [activeId, setActiveId] = useState(CURRENT_FOLDER_RESOURCE);
  const [decisions, setDecisions] = useState<Record<string, RemoteFetchFileDecision>>({});
  const [plan, setPlan] = useState<WorkFolderEditPlan | null>(null);
  const [plannedRevision, setPlannedRevision] = useState("");
  const [planFailed, setPlanFailed] = useState(false);
  const [planAttempt, setPlanAttempt] = useState(0);
  const [assign, setAssign] = useState(true);
  const [applying, setApplying] = useState(false);
  const [layout, setLayout] = useState<FolderEditLayout>(emptyFolderEditLayout);
  const [merged, setMerged] = useState<ReadonlySet<number>>(new Set());
  const requestId = useRef(createFolderWorkspaceRequestId("edit"));
  // Only the first load opens on the remote edition a Fetch asked for.
  const pendingInitialRemote = useRef(initialRemote ?? null);

  // The edited folder's files come from the page; everything in it stays
  // selected until the user clears it.
  useEffect(() => {
    setFiles((current) => ({ ...current, [CURRENT_FOLDER_RESOURCE]: { status: "ready", files: currentFiles } }));
    setSelection((current) => ({
      ...current,
      [CURRENT_FOLDER_RESOURCE]: new Set(currentFiles.map((file) => file.path)),
    }));
  }, [currentFiles, setFiles, setSelection]);

  const selectResource = useCallback(
    (resource: FolderEditResource) => {
      setActiveId(resource.id);
      if (!files[resource.id] || files[resource.id].status === "error") void loadResource(resource);
    },
    [files, loadResource],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSourcesStatus("loading");
    api.getWorkFolderEditSources(target.workId, controller.signal).then(
      (sources) => {
        const next = folderEditResources(sources, target);
        setResources(next);
        setSourcesStatus("ready");
        const wanted = pendingInitialRemote.current;
        pendingInitialRemote.current = null;
        if (!wanted) return;
        const remote = folderEditRemoteResource(next, wanted.sourceId, wanted.remoteCode);
        if (!remote) return;
        setActiveId(remote.id);
        void loadResource(remote);
      },
      () => {
        if (!controller.signal.aborted) setSourcesStatus("error");
      },
    );
    return () => controller.abort();
  }, [loadResource, sourcesAttempt, target]);

  // A check asks the remote sources again; until then the list shows the
  // availability they reported last.
  const [remoteCheck, setRemoteCheck] = useState<"idle" | "checking">("idle");
  const remoteCheckAbort = useRef<AbortController | null>(null);
  useEffect(() => () => remoteCheckAbort.current?.abort(), []);
  const checkRemote = useCallback(async () => {
    if (remoteCheckAbort.current) return;
    const controller = new AbortController();
    remoteCheckAbort.current = controller;
    setRemoteCheck("checking");
    try {
      const next = folderEditResources(await api.checkWorkFolderEditSources(target.workId, controller.signal), target);
      setResources(next);
      // A folder the check found offline cannot be merged.
      setMerged((current) => new Set(folderEditMerges(next, current)));
      setSourcesStatus("ready");
      const found = next.filter((resource) => resource.kind === "remote").length;
      if (found > 0) toast.success(t("folderEdit.remoteCheckFound", { count: found }));
      else toast.info(t("folderEdit.remoteCheckNone"));
    } catch (error) {
      if (!controller.signal.aborted) toast.notify(toastFromError(error, t("folderEdit.remoteCheckFailed")));
    } finally {
      if (remoteCheckAbort.current === controller) remoteCheckAbort.current = null;
      if (!controller.signal.aborted) setRemoteCheck("idle");
    }
  }, [t, target, toast]);

  const merges = useMemo(() => folderEditMerges(resources, merged), [merged, resources]);
  // A file that is cleared, or becomes lyrics, gives up its place, so selecting
  // it again cannot land it where another file has gone since.
  const placementKeys = useMemo(
    () =>
      folderEditPlacementKeys({ resources, files: readyFiles, selection, lyrics, keyFor: folderEditResourceItemKey }),
    [lyrics, readyFiles, resources, selection],
  );
  useEffect(() => setLayout((current) => prunedLayout(current, placementKeys)), [placementKeys]);
  const request = useMemo(
    () => folderEditRequest({ target, resources, files: readyFiles, selection, lyrics, decisions, layout, merges }),
    [decisions, layout, lyrics, merges, readyFiles, resources, selection, target],
  );
  const revision = useMemo(() => JSON.stringify(request), [request]);
  const needsPlan = folderEditNeedsPlan(request);

  useEffect(() => {
    if (!needsPlan || applying) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.planWorkFolderEdit(target.workId, request).then(
        (next) => {
          if (cancelled) return;
          setPlan(next);
          setPlannedRevision(revision);
          setPlanFailed(false);
        },
        () => {
          if (!cancelled) setPlanFailed(true);
        },
      );
    }, PLAN_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The request is identified by its revision.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [applying, needsPlan, planAttempt, revision, target.workId]);

  const currentPlan = needsPlan ? plan : null;
  const planCurrent = needsPlan && plannedRevision === revision;
  const readiness = folderEditReadiness({ request, plan: currentPlan, planCurrent });
  const currentSelection = selection[CURRENT_FOLDER_RESOURCE] ?? noSelection;
  // Until the preview catches up, the final folder shows only what is still
  // selected, and a newly selected file as pending.
  const shownPlan = useMemo(() => {
    if (!currentPlan) return null;
    const keys = new Set(request.additions.map(folderEditItemKey));
    return { ...currentPlan, items: currentPlan.items.filter((item) => keys.has(item.itemKey)) };
  }, [currentPlan, request.additions]);
  const pending = useMemo(() => {
    const additions: FolderEditPendingAddition[] = [];
    for (const resource of resources) {
      if (resource.kind === "current") continue;
      const selected = selection[resource.id];
      for (const file of readyFiles[resource.id] ?? []) {
        if (!selected?.has(file.path) || lyrics[resource.id]?.[file.path] !== undefined) continue;
        const key = folderEditResourceItemKey(resource, file.path);
        additions.push({ key, path: file.path, kind: file.kind, sizeBytes: file.sizeBytes });
      }
    }
    return additions;
  }, [lyrics, readyFiles, resources, selection]);
  const result = useMemo(
    () => folderEditResult(currentFiles, currentSelection, shownPlan, layout, pending),
    [currentFiles, currentSelection, layout, pending, shownPlan],
  );
  const removedFiles = useMemo(
    () => currentFiles.filter((file) => !currentSelection.has(file.path)),
    [currentFiles, currentSelection],
  );
  const lyricsAdditionCount = request.additions.filter((addition) => addition.language !== undefined).length;
  const assignments = useMemo(() => {
    if (!canAssign || !assign || !planCurrent || !currentPlan || lyricsAdditionCount === 0) return [];
    const kept = folderAudio(currentItems, target.rootPath).filter((audio) => currentSelection.has(audio.path));
    const addedAudio = result
      .filter((entry) => entry.kind === "audio" && (entry.state === "add_local" || entry.state === "add_remote"))
      .map((entry) => entry.path);
    return folderEditAssignments({ audio: kept, addedAudio, additions: request.additions, items: currentPlan.items });
  }, [
    assign,
    canAssign,
    currentItems,
    currentPlan,
    currentSelection,
    lyricsAdditionCount,
    planCurrent,
    request.additions,
    result,
    target.rootPath,
  ]);

  /**
   * Applies the edit. An edit that merges folders passes the merge check it was reviewed with: the
   * request the check compared, which must still be the edit, and the check's review.
   */
  const apply = async (mergeReview?: { request: WorkFolderEditRequest; review: string }) => {
    if (readiness !== "ready" || applying) return;
    if (mergeReview && JSON.stringify(mergeReview.request) !== revision) {
      toast.notify({ kind: "warning", message: t("folderEdit.mergeChanged") });
      return;
    }
    setApplying(true);
    try {
      onApplied(
        await api.applyWorkFolderEdit(target.workId, {
          ...request,
          ...(assignments.length > 0 ? { assignments } : {}),
          ...(mergeReview ? { mergeReview: mergeReview.review } : {}),
          requestId: requestId.current,
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "folder_edit_merge_changed") {
        setPlannedRevision("");
        setPlanAttempt((value) => value + 1);
        toast.notify({ kind: "warning", message: t("folderEdit.mergeChanged") });
      } else if (error instanceof ApiError && error.status === 409 && error.code === "folder_edit_conflict") {
        // The folder changed since the preview; show what it holds now.
        setPlannedRevision("");
        setPlanAttempt((value) => value + 1);
        toast.notify({ kind: "warning", message: t("folderEdit.folderChanged") });
      } else {
        toast.notify(toastFromError(error, t("folderEdit.applyFailed")));
      }
    } finally {
      setApplying(false);
    }
  };

  const workspace: FolderWorkspace = {
    resources,
    sourcesStatus,
    retrySources: () => setSourcesAttempt((value) => value + 1),
    remoteCheck: localOnly ? undefined : { checking: remoteCheck === "checking", check: () => void checkRemote() },
    localOnly,
    files,
    selection,
    lyrics,
    activeResource: resources.find((resource) => resource.id === activeId) ?? resources[0] ?? currentResource,
    selectResource,
    retryResource: (resource: FolderEditResource) => void loadResource(resource),
    setSelected,
    setLyricsRole,
    decisions,
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDecisions((current) => ({ ...current, [decision.itemKey]: decision })),
    additionCount: request.additions.length,
    lyricsAdditionCount,
    rootPath: target.rootPath,
    result,
    readiness,
    addCount: currentPlan?.summary.add ?? 0,
    removeCount: request.removeLocationIds.length,
    conflictCount: currentPlan?.summary.conflict ?? 0,
    planFailed: needsPlan && planFailed && !planCurrent,
    retryPlan: () => {
      setPlanFailed(false);
      setPlanAttempt((value) => value + 1);
    },
    canAssign,
    assign,
    setAssign,
    assignmentCount: assignments.length,
    applying,
    arrange: folderWorkspaceArrange({
      layout,
      setLayout,
      entries: result,
      include: (resource, paths) => {
        setSelection((current) => ({
          ...current,
          [resource.id]: withFolderEditPaths(current[resource.id] ?? new Set(), paths, true),
        }));
        if (resource.kind !== "current") setLyricsRole(resource.id, paths, null);
      },
      forget: (keys) =>
        setDecisions((current) => {
          const next = { ...current };
          for (const key of keys) delete next[key];
          return next;
        }),
      keyFor: folderEditResourceItemKey,
    }),
    merge: {
      folderIds: merged,
      setMerged: (resource, merging) => {
        // A place merges only once its files are loaded, so it takes all of them.
        const state = files[resource.id];
        if (merging ? !folderEditCanMerge(resource, state) : resource.kind !== "local") return;
        setMerged((current) => {
          const next = new Set(current);
          if (merging) next.add(resource.folderId);
          else next.delete(resource.folderId);
          return next;
        });
        // Merging a place takes all of it unless some of it is already chosen.
        if (merging && state?.status === "ready" && !(selection[resource.id]?.size ?? 0)) {
          setSelected(resource.id, new Set(state.files.map((file) => file.path)));
        }
      },
    },
  };
  return {
    ...workspace,
    removedFiles,
    apply,
    request,
    mergePlan: planCurrent ? (currentPlan?.merges ?? []) : [],
  };
}

export type FolderEditWorkspace = ReturnType<typeof useFolderEditWorkspace>;

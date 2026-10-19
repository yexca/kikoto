import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { emptyFolderEditLayout, type FolderEditLayout } from "@/features/work-detail/folder-edit/folderEditLayout";
import {
  fetchComposeAddCount,
  fetchComposeReadiness,
  fetchComposeRequest,
  fetchComposeResources,
  fetchComposeResult,
  fetchItemKey,
  folderEditItemKey,
  folderEditResourceItemKey,
  withFolderEditPaths,
  type FetchComposeTarget,
  type FolderEditPendingAddition,
  type FolderEditResource,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { folderEditAssignments } from "@/features/work-detail/folder-edit/folderEditLyrics";
import {
  createFolderWorkspaceRequestId,
  folderWorkspaceArrange,
  useFolderWorkspaceFiles,
  type FolderWorkspace,
} from "@/features/work-detail/folder-edit/folderWorkspace";
import {
  api,
  type ComposedFetchPlan,
  type RemoteFetchFileDecision,
  type RemoteFetchPreparation,
  type RemoteWorkSaveResult,
} from "@/lib/api";
import { DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES } from "@/lib/remoteSourceApi";

const PLAN_DELAY_MS = 600;

/**
 * The state of a Fetch into a new folder that takes files from several places:
 * the fetched edition's files, the files of other editions, sources, and
 * local folders, and lyrics of a declared language. The fetched edition's
 * files start selected, so an unchanged selection fetches the edition as a
 * plain Fetch does.
 */
export function useFetchComposeWorkspace({
  fetch,
  canAssign,
  onApplied,
}: {
  fetch: FetchComposeTarget;
  /** Whether the viewer may assign added lyrics to tracks. */
  canAssign: boolean;
  /** Receives the queued Fetch, and whether files follow once it has published the folder. */
  onApplied: (result: RemoteWorkSaveResult, followUp: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [preparation, setPreparation] = useState<RemoteFetchPreparation | null>(null);
  const resources = useMemo(() => fetchComposeResources(preparation, fetch), [fetch, preparation]);
  const primary = resources[0];
  const [sourcesStatus, setSourcesStatus] = useState<"loading" | "ready" | "error">("loading");
  const { files, selection, setSelection, setSelected, lyrics, setLyricsRole, loadResource, readyFiles } =
    useFolderWorkspaceFiles();
  const [activeId, setActiveId] = useState(primary.id);
  const [decisions, setDecisions] = useState<Record<string, RemoteFetchFileDecision>>({});
  const [plan, setPlan] = useState<ComposedFetchPlan | null>(null);
  const [plannedRevision, setPlannedRevision] = useState("");
  const [planFailed, setPlanFailed] = useState(false);
  const [planAttempt, setPlanAttempt] = useState(0);
  const [assign, setAssign] = useState(true);
  const [applying, setApplying] = useState(false);
  const requestId = useRef(createFolderWorkspaceRequestId("fetch"));

  // The fetched edition opens with every file selected.
  const [primaryAttempt, setPrimaryAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSourcesStatus("loading");
    void loadResource(primary).then((loaded) => {
      if (cancelled) return;
      if (!loaded) {
        setSourcesStatus("error");
        return;
      }
      setSourcesStatus("ready");
      setSelection((current) =>
        current[primary.id] ? current : { ...current, [primary.id]: new Set(loaded.map((file) => file.path)) },
      );
    });
    return () => {
      cancelled = true;
    };
    // The fetched edition is fixed for the workspace.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAttempt]);

  const selectResource = useCallback(
    (resource: FolderEditResource) => {
      setActiveId(resource.id);
      if (!files[resource.id] || files[resource.id].status === "error") void loadResource(resource);
    },
    [files, loadResource],
  );

  const [layout, setLayout] = useState<FolderEditLayout>(emptyFolderEditLayout);
  // The fetched edition's files are keyed as the Fetch plans them, any other
  // place's as the follow-up does.
  const keyFor = useCallback(
    (resource: FolderEditResource, path: string) =>
      resource.id === primary.id ? fetchItemKey(path) : folderEditResourceItemKey(resource, path),
    [primary.id],
  );
  const request = useMemo(
    () =>
      fetchComposeRequest({
        fetch,
        resources,
        files: readyFiles,
        selection,
        lyrics,
        decisions,
        minFreeBytes: DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
        layout,
      }),
    [decisions, fetch, layout, lyrics, readyFiles, resources, selection],
  );
  const revision = useMemo(() => JSON.stringify(request), [request]);
  const needsPlan = request.paths.length > 0;

  // The preview also reports the family's editions, which list the other places.
  useEffect(() => {
    if (!needsPlan || applying) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.planComposedFetch(fetch.sourceId, fetch.remoteCode, request).then(
        (next) => {
          if (cancelled) return;
          setPlan(next);
          setPreparation(next.preparation);
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
  }, [applying, needsPlan, planAttempt, revision, fetch.sourceId, fetch.remoteCode]);

  const currentPlan = needsPlan ? plan : null;
  const planCurrent = needsPlan && plannedRevision === revision;
  const readiness = fetchComposeReadiness({ request, plan: currentPlan, planCurrent });
  const pending = useMemo(() => {
    const additions: FolderEditPendingAddition[] = [];
    for (const resource of resources) {
      const selected = selection[resource.id];
      for (const file of readyFiles[resource.id] ?? []) {
        if (!selected?.has(file.path) || lyrics[resource.id]?.[file.path] !== undefined) continue;
        additions.push({
          key: keyFor(resource, file.path),
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
        });
      }
    }
    return additions;
  }, [keyFor, lyrics, readyFiles, resources, selection]);
  const requestKeys = useMemo(
    () => new Set([...request.paths.map(fetchItemKey), ...(request.followUp?.additions ?? []).map(folderEditItemKey)]),
    [request],
  );
  const result = useMemo(
    () => fetchComposeResult(currentPlan, layout, pending, requestKeys),
    [currentPlan, layout, pending, requestKeys],
  );
  const additions = request.followUp?.additions;
  const lyricsAdditionCount = (additions ?? []).filter((addition) => addition.language !== undefined).length;
  const assignments = useMemo(() => {
    if (!canAssign || !assign || !planCurrent || !currentPlan || !additions || lyricsAdditionCount === 0) return [];
    const addedAudio = result
      .filter((entry) => entry.kind === "audio" && entry.state !== "conflict" && entry.state !== "excluded")
      .map((entry) => entry.path);
    return folderEditAssignments({
      audio: [],
      addedAudio,
      additions,
      items: currentPlan.followUp?.items ?? [],
    });
  }, [additions, assign, canAssign, currentPlan, lyricsAdditionCount, planCurrent, result]);

  const apply = async () => {
    if (readiness !== "ready" || applying || !currentPlan) return;
    setApplying(true);
    try {
      const followUp = request.followUp
        ? { ...request.followUp, ...(assignments.length > 0 ? { assignments } : {}) }
        : undefined;
      await onApplied(
        await api.applyComposedFetch(fetch.sourceId, fetch.remoteCode, {
          ...request,
          followUp,
          requestId: requestId.current,
          targetRoot: currentPlan.saveRoot,
        }),
        Boolean(followUp),
      );
    } catch (error) {
      // A conflict means the folder or a source changed since the preview.
      setPlannedRevision("");
      setPlanAttempt((value) => value + 1);
      toast.notify(toastFromError(error, t("fetchCompose.applyFailed")));
    } finally {
      setApplying(false);
    }
  };

  const workspace: FolderWorkspace = {
    resources,
    sourcesStatus,
    retrySources: () => setPrimaryAttempt((value) => value + 1),
    files,
    selection,
    lyrics,
    activeResource: resources.find((resource) => resource.id === activeId) ?? primary,
    selectResource,
    retryResource: (resource: FolderEditResource) => void loadResource(resource),
    setSelected,
    setLyricsRole,
    decisions,
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDecisions((current) => ({ ...current, [decision.itemKey]: decision })),
    additionCount: request.paths.length + (additions?.length ?? 0),
    lyricsAdditionCount,
    rootPath: currentPlan?.saveRoot ?? "",
    result,
    readiness,
    addCount: fetchComposeAddCount(currentPlan),
    removeCount: 0,
    conflictCount: (currentPlan?.summary.conflict ?? 0) + (currentPlan?.followUp?.summary.conflict ?? 0),
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
        setLyricsRole(resource.id, paths, null);
      },
      forget: (keys) =>
        setDecisions((current) => {
          const next = { ...current };
          for (const key of keys) delete next[key];
          return next;
        }),
      keyFor,
      // A Fetch publishes files; a folder that holds none is not created.
      createsEmptyFolders: false,
    }),
  };
  return {
    ...workspace,
    primaryId: primary.id,
    fetchRoot: currentPlan?.fetchRoot ?? null,
    apply,
  };
}

export type FetchComposeWorkspace = ReturnType<typeof useFetchComposeWorkspace>;

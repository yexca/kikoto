import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  emptyFolderEditLayout,
  prunedLayout,
  type FolderEditLayout,
} from "@/features/work-detail/folder-edit/folderEditLayout";
import {
  fetchComposeAddCount,
  fetchComposeReadiness,
  fetchComposeRequest,
  fetchComposeResources,
  fetchComposeResult,
  fetchItemKey,
  folderEditItemKey,
  folderEditPlacementKeys,
  folderEditResourceItemKey,
  withFolderEditPaths,
  type FetchComposeTarget,
  type FolderEditPendingAddition,
  type FolderEditResource,
} from "@/features/work-detail/folder-edit/folderEditModel";
import {
  createFolderWorkspaceRequestId,
  folderWorkspaceArrange,
  useFolderWorkspaceFiles,
  type FolderWorkspace,
} from "@/features/work-detail/folder-edit/folderWorkspace";
import { useDebouncedRequest } from "@/hooks/useDebouncedRequest";
import { useStableCallback } from "@/hooks/useStableCallback";
import {
  api,
  type ComposedFetchPlan,
  type RemoteFetchFileDecision,
  type RemoteFetchPreparation,
  type RemoteWorkSaveResult,
} from "@/lib/api";
import { startLoad } from "@/lib/effectScope";
import { DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES } from "@/lib/remoteSourceApi";

const PLAN_DELAY_MS = 600;

/**
 * The state of a Fetch into a new folder that takes files from several places:
 * the fetched edition's files and the files of other editions, sources, and
 * local folders. The fetched edition's files start selected, so an unchanged
 * selection fetches the edition as a plain Fetch does.
 */
export function useFetchComposeWorkspace({
  fetch,
  onApplied,
}: {
  fetch: FetchComposeTarget;
  /** Receives the queued Fetch, and whether files follow once it has published the folder. */
  onApplied: (result: RemoteWorkSaveResult, followUp: boolean) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [preparation, setPreparation] = useState<RemoteFetchPreparation | null>(null);
  const resources = useMemo(() => fetchComposeResources(preparation, fetch), [fetch, preparation]);
  const primary = resources[0];
  const [sourcesStatus, setSourcesStatus] = useState<"loading" | "ready" | "error">("loading");
  const { files, selection, setSelection, setSelected, loadResource, readyFiles } = useFolderWorkspaceFiles();
  const [activeId, setActiveId] = useState(primary.id);
  const [decisions, setDecisions] = useState<Record<string, RemoteFetchFileDecision>>({});
  const [applying, setApplying] = useState(false);
  const requestId = useRef(createFolderWorkspaceRequestId("fetch"));

  // The fetched edition opens with every file selected.
  const [primaryAttempt, setPrimaryAttempt] = useState(0);
  // The fetched edition is fixed for the workspace, so only a retry loads it again.
  const loadPrimary = useStableCallback(async () => ({ id: primary.id, loaded: await loadResource(primary) }));
  useEffect(() => {
    setSourcesStatus("loading");
    return startLoad(loadPrimary, {
      onSuccess: ({ id, loaded }) => {
        if (!loaded) {
          setSourcesStatus("error");
          return;
        }
        setSourcesStatus("ready");
        setSelection((current) =>
          current[id] ? current : { ...current, [id]: new Set(loaded.map((file) => file.path)) },
        );
      },
    });
  }, [loadPrimary, primaryAttempt, setSelection]);

  const openResource = useCallback(
    (resource: FolderEditResource) => {
      if (!files[resource.id] || files[resource.id].status === "error") void loadResource(resource);
    },
    [files, loadResource],
  );
  const selectResource = useCallback(
    (resource: FolderEditResource) => {
      setActiveId(resource.id);
      openResource(resource);
    },
    [openResource],
  );

  const [layout, setLayout] = useState<FolderEditLayout>(emptyFolderEditLayout);
  // The fetched edition's files are keyed as the Fetch plans them, any other
  // place's as the follow-up does.
  const keyFor = useCallback(
    (resource: FolderEditResource, path: string) =>
      resource.id === primary.id ? fetchItemKey(path) : folderEditResourceItemKey(resource, path),
    [primary.id],
  );
  // A file that is cleared gives up its place.
  const placementKeys = useMemo(
    () => folderEditPlacementKeys({ resources, files: readyFiles, selection, keyFor }),
    [keyFor, readyFiles, resources, selection],
  );
  useEffect(() => setLayout((current) => prunedLayout(current, placementKeys)), [placementKeys]);
  const request = useMemo(
    () =>
      fetchComposeRequest({
        fetch,
        resources,
        files: readyFiles,
        selection,
        decisions,
        minFreeBytes: DEFAULT_MANUAL_FETCH_MIN_FREE_BYTES,
        layout,
      }),
    [decisions, fetch, layout, readyFiles, resources, selection],
  );
  const revision = useMemo(() => JSON.stringify(request), [request]);
  const needsPlan = request.paths.length > 0;

  const planRequest = useDebouncedRequest<ComposedFetchPlan>({
    key: `${fetch.sourceId}:${fetch.remoteCode}:${revision}`,
    enabled: needsPlan && !applying,
    delayMs: PLAN_DELAY_MS,
    send: (signal) => api.planComposedFetch(fetch.sourceId, fetch.remoteCode, request, signal),
    // The preview also reports the family's editions, which list the other places.
    onResult: (next) => setPreparation(next.preparation),
  });
  const plan = planRequest.result;

  const currentPlan = needsPlan ? plan : null;
  const planCurrent = needsPlan && planRequest.current;
  const readiness = fetchComposeReadiness({ request, plan: currentPlan, planCurrent });
  const pending = useMemo(() => {
    const additions: FolderEditPendingAddition[] = [];
    for (const resource of resources) {
      const selected = selection[resource.id];
      for (const file of readyFiles[resource.id] ?? []) {
        if (!selected?.has(file.path)) continue;
        additions.push({
          key: keyFor(resource, file.path),
          path: file.path,
          kind: file.kind,
          sizeBytes: file.sizeBytes,
        });
      }
    }
    return additions;
  }, [keyFor, readyFiles, resources, selection]);
  const requestKeys = useMemo(
    () => new Set([...request.paths.map(fetchItemKey), ...(request.followUp?.additions ?? []).map(folderEditItemKey)]),
    [request],
  );
  const result = useMemo(
    () => fetchComposeResult(currentPlan, layout, pending, requestKeys),
    [currentPlan, layout, pending, requestKeys],
  );
  const additions = request.followUp?.additions;

  const apply = async () => {
    if (readiness !== "ready" || applying || !currentPlan) return;
    setApplying(true);
    const followUp = request.followUp;
    let applied: RemoteWorkSaveResult;
    try {
      applied = await api.applyComposedFetch(fetch.sourceId, fetch.remoteCode, {
        ...request,
        followUp,
        requestId: requestId.current,
        targetRoot: currentPlan.saveRoot,
      });
    } catch (error) {
      // A conflict means the folder or a source changed since the preview.
      planRequest.invalidate();
      toast.notify(toastFromError(error, t("fetchCompose.applyFailed")));
      setApplying(false);
      return;
    }
    try {
      await onApplied(applied, Boolean(followUp));
    } catch {
      // The Fetch is queued; a page that fails to refresh afterwards did not
      // fail it.
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
    activeResource: resources.find((resource) => resource.id === activeId) ?? primary,
    selectResource,
    openResource,
    retryResource: (resource: FolderEditResource) => void loadResource(resource),
    setSelected,
    decisions,
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDecisions((current) => ({ ...current, [decision.itemKey]: decision })),
    additionCount: request.paths.length + (additions?.length ?? 0),
    rootPath: currentPlan?.saveRoot ?? "",
    result,
    readiness,
    addCount: fetchComposeAddCount(currentPlan),
    removeCount: 0,
    conflictCount: (currentPlan?.summary.conflict ?? 0) + (currentPlan?.followUp?.summary.conflict ?? 0),
    planFailed: needsPlan && planRequest.failed && !planCurrent,
    retryPlan: planRequest.retry,
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

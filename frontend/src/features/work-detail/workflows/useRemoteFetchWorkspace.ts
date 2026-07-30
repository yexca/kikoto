import { useMemo, useRef, useState } from "react";

import { usePermissionGate } from "@/auth/usePermissionGate";
import { toastFromError, useToast } from "@/components/ui/toast";
import { buildRemoteTree, emptyTree, remoteSelectablePaths } from "@/features/work-detail/media/mediaTreeModel";
import {
  createRemoteFetchDraft,
  formatRemoteFetchPreparation,
  remoteDetailActionCode,
  selectRemoteFetchEdition,
  type FetchIntent,
  type RemoteFetchDraft,
} from "@/features/work-detail/workflows/remoteFetchWorkspaceModel";
import { api, ApiError, type RemoteFetchFileDecision, type RemoteWorkSaveResult } from "@/lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";

export type { FetchIntent, RemoteFetchDraft } from "@/features/work-detail/workflows/remoteFetchWorkspaceModel";

export function useRemoteFetchWorkspace({
  onWorksChanged,
}: {
  onWorksChanged?: () => void | Promise<void>;
} = {}) {
  const toast = useToast();
  const requireDownloadsManage = usePermissionGate("downloads:manage");
  const [draft, setDraft] = useState<RemoteFetchDraft | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const busyRef = useRef(false);
  const tree = useMemo(() => (draft ? buildRemoteTree(draft.detail.tracks) : emptyTree()), [draft?.detail]);
  const selectedPaths = useMemo(() => sortedValues(draft?.selectedPaths), [draft?.selectedPaths]);
  const selectedLocalPaths = useMemo(() => sortedValues(draft?.selectedLocalPaths), [draft?.selectedLocalPaths]);

  const open = async (intent: FetchIntent) => {
    const remoteCode = intent.remoteCode.trim();
    if (intent.sourceId <= 0 || !remoteCode || !requireDownloadsManage()) return false;
    if (!beginOperation()) return false;
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const detail = fetchIntentDetailMatches(intent, remoteCode)
        ? intent.detail!
        : await api.getRemoteSourceWork(intent.sourceId, remoteCode);
      const paths = remoteSelectablePaths(buildRemoteTree(detail.tracks));
      if (paths.length === 0) {
        toast.notify({ kind: "warning", message: "No remote files are available to fetch." });
        return false;
      }
      const plan = await api.planRemoteSourceWorkFetch(intent.sourceId, remoteDetailActionCode(detail), paths);
      setDraft(createRemoteFetchDraft({ intent, detail, paths, plan }));
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch preparation failed."));
      return false;
    } finally {
      endOperation();
    }
  };

  const selectEdition = async (editionCode: string) => {
    if (!draft) return false;
    const cleanCode = editionCode.trim();
    if (!cleanCode) return false;
    if (!beginOperation()) return false;
    try {
      const detail = await api.getRemoteSourceWork(draft.intent.sourceId, cleanCode);
      const paths = remoteSelectablePaths(buildRemoteTree(detail.tracks));
      if (paths.length === 0) {
        toast.notify({ kind: "warning", message: `No remote files are available for the ${cleanCode} edition.` });
        return false;
      }
      setDraft((current) => (current ? selectRemoteFetchEdition({ draft: current, detail, paths }) : current));
      return true;
    } catch (error) {
      const sourceName = draft.intent.sourceDisplayName || draft.detail.sourceName || "this source";
      toast.notify(toastFromError(error, `The ${cleanCode} edition is not available from ${sourceName}.`));
      return false;
    } finally {
      endOperation();
    }
  };

  const save = async () => {
    if (!draft || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    if (!requireDownloadsManage()) return;
    if (!beginOperation()) return;
    let publishing = false;
    try {
      if (!draft.plan || draft.planDirty) {
        const plan = await api.planRemoteSourceWorkFetch(
          draft.intent.sourceId,
          remoteDetailActionCode(draft.detail),
          selectedPaths,
          selectedLocalPaths,
          draft.targetRoot,
          decisionList(draft.decisions),
        );
        setDraft((current) =>
          current
            ? {
                ...current,
                plan,
                preparation: plan.preparation,
                planDirty: false,
                message: formatRemoteFetchPreparation(plan),
              }
            : current,
        );
        return;
      }
      if (hasRemoteFetchConflicts(draft.plan)) {
        setDraft((current) =>
          current ? { ...current, message: formatRemoteFetchPlanConflict(draft.plan!) } : current,
        );
        return;
      }
      publishing = true;
      const result = await api.fetchRemoteSourceWork(
        draft.intent.sourceId,
        remoteDetailActionCode(draft.detail),
        selectedPaths,
        selectedLocalPaths,
        draft.requestId,
        draft.targetRoot || draft.plan.saveRoot,
        decisionList(draft.decisions),
      );
      notifyFetchQueued(toast, result);
      setDraft(null);
      try {
        await onWorksChanged?.();
      } catch (error) {
        toast.notify({
          kind: "warning",
          message:
            error instanceof Error
              ? `Fetch was queued, but the current view could not refresh: ${error.message}`
              : "Fetch was queued, but the current view could not refresh.",
        });
      }
    } catch (error) {
      if (!publishing) {
        toast.notify(toastFromError(error, "Fetch plan failed."));
      } else if (error instanceof ApiError && error.status === 401) {
        toast.notify(toastFromError(error, "Fetch submission failed."));
      } else {
        notifyFetchUnconfirmed(toast);
      }
    } finally {
      endOperation();
    }
  };

  return {
    draft,
    tree,
    isBusy,
    open,
    selectEdition,
    save,
    close: () => {
      if (!busyRef.current) setDraft(null);
    },
    setTargetRoot: (targetRoot: string) =>
      setDraft((current) => (current ? { ...current, targetRoot, planDirty: true, message: "" } : current)),
    setSelectedPaths: (paths: Set<string>) =>
      setDraft((current) => (current ? { ...current, selectedPaths: paths, planDirty: true, message: "" } : current)),
    setSelectedLocalPaths: (paths: Set<string>) =>
      setDraft((current) =>
        current ? { ...current, selectedLocalPaths: paths, planDirty: true, message: "" } : current,
      ),
    setDecision: (decision: RemoteFetchFileDecision) =>
      setDraft((current) =>
        current
          ? {
              ...current,
              decisions: { ...current.decisions, [decision.itemKey]: decision },
              planDirty: true,
            }
          : current,
      ),
  };

  function beginOperation() {
    if (busyRef.current) return false;
    busyRef.current = true;
    setIsBusy(true);
    return true;
  }

  function endOperation() {
    busyRef.current = false;
    setIsBusy(false);
  }
}

export type RemoteFetchWorkspace = ReturnType<typeof useRemoteFetchWorkspace>;

function sortedValues(values: Set<string> | undefined) {
  return Array.from(values ?? []).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function decisionList(decisions: Record<string, RemoteFetchFileDecision>) {
  return Object.values(decisions).sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

function fetchIntentDetailMatches(intent: FetchIntent, remoteCode: string) {
  const detail = intent.detail;
  if (!detail || detail.sourceId !== intent.sourceId) return false;
  return [remoteDetailActionCode(detail), detail.remoteId, detail.primaryCode].some(
    (candidate) => candidate.trim() === remoteCode,
  );
}

function notifyFetchQueued(toast: ReturnType<typeof useToast>, result: RemoteWorkSaveResult) {
  toast.notify({
    kind: "success",
    message: result.deduplicated
      ? `Fetch was already queued as workflow run #${result.runId}.`
      : `Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`,
    actionLabel: "Activity",
    onAction: () => openActivity(`/activity?run=${result.runId}`),
  });
}

function notifyFetchUnconfirmed(toast: ReturnType<typeof useToast>) {
  toast.notify({
    kind: "warning",
    message:
      "Fetch submission could not be confirmed. It may still be running; check Activity or retry this selection.",
    actionLabel: "Activity",
    onAction: () => openActivity("/activity"),
  });
}

function openActivity(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

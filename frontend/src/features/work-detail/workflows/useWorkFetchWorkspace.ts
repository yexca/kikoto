import { useEffect, useMemo, useState } from "react";

import { toastFromError, useToast } from "@/components/ui/toast";
import {
  buildRemoteTree,
  emptyTree,
  remoteSelectablePaths,
} from "@/features/work-detail/media/mediaTreeModel";
import type { RemoteSourceAvailability } from "@/features/work-detail/source/sourceContextModel";
import {
  api,
  type RemoteFetchFileDecision,
  type RemoteWorkDetail,
  type RemoteWorkSavePlan,
  type RemoteWorkSaveResult,
} from "@/lib/api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "@/lib/remoteFetchPlan";

export type WorkFetchDraft = {
  detail: RemoteWorkDetail;
  selectedPaths: Set<string>;
  selectedLocalPaths: Set<string>;
  targetRoot: string;
  plan: RemoteWorkSavePlan | null;
  decisions: Record<string, RemoteFetchFileDecision>;
  planDirty: boolean;
  message: string;
};

export function useWorkFetchWorkspace({
  remote,
  remoteCode,
  remoteFilePaths,
  onWorksChanged,
}: {
  remote: RemoteSourceAvailability | undefined;
  remoteCode: string;
  remoteFilePaths: string[];
  onWorksChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<WorkFetchDraft | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const tree = useMemo(() => draft ? buildRemoteTree(draft.detail.tracks) : emptyTree(), [draft?.detail]);
  const selectedPaths = useMemo(() => Array.from(draft?.selectedPaths ?? []).sort(naturalCompare), [draft?.selectedPaths]);
  const selectedLocalPaths = useMemo(() => Array.from(draft?.selectedLocalPaths ?? []).sort(naturalCompare), [draft?.selectedLocalPaths]);

  useEffect(() => {
    if (draft && remote?.source.id !== draft.detail.sourceId) setDraft(null);
  }, [draft, remote?.source.id]);

  const open = async () => {
    if (!remote || !remoteCode.trim()) return;
    setIsBusy(true);
    toast.info("Preparing language editions, source files, and the final Fetch tree…");
    try {
      const detail = remote.detail ?? await api.getRemoteSourceWork(remote.source.id, remoteCode);
      const paths = remoteFilePaths.length > 0
        ? remoteFilePaths
        : remoteSelectablePaths(buildRemoteTree(detail.tracks));
      if (paths.length === 0) {
        toast.notify({ kind: "warning", message: "No remote files are available to fetch." });
        return;
      }
      const plan = await api.planRemoteSourceWorkFetch(remote.source.id, remoteDetailActionCode(detail), paths);
      setDraft({
        detail,
        selectedPaths: new Set(paths),
        selectedLocalPaths: new Set(),
        targetRoot: "",
        plan,
        decisions: {},
        planDirty: false,
        message: formatRemoteFetchPreparation(plan),
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Fetch preparation failed."));
    } finally {
      setIsBusy(false);
    }
  };

  const selectEdition = async (editionCode: string) => {
    if (!remote) return false;
    setIsBusy(true);
    try {
      const detail = await api.getRemoteSourceWork(remote.source.id, editionCode);
      setDraft((current) => current ? {
        ...current,
        detail,
        selectedPaths: new Set(remoteSelectablePaths(buildRemoteTree(detail.tracks))),
        selectedLocalPaths: new Set(),
        targetRoot: "",
        plan: null,
        decisions: {},
        planDirty: false,
        message: "",
      } : current);
      return true;
    } catch (error) {
      toast.notify(toastFromError(error, `The ${editionCode} edition is not available from ${remote.source.displayName}.`));
      return false;
    } finally {
      setIsBusy(false);
    }
  };

  const save = async () => {
    if (!remote || !draft || (selectedPaths.length === 0 && selectedLocalPaths.length === 0)) return;
    setIsBusy(true);
    try {
      if (!draft.plan || draft.planDirty) {
        const plan = await api.planRemoteSourceWorkFetch(remote.source.id, remoteDetailActionCode(draft.detail), selectedPaths, selectedLocalPaths, draft.targetRoot, Object.values(draft.decisions));
        setDraft((current) => current ? { ...current, plan, planDirty: false, message: formatRemoteFetchPreparation(plan) } : current);
        return;
      }
      if (hasRemoteFetchConflicts(draft.plan)) {
        setDraft((current) => current ? { ...current, message: formatRemoteFetchPlanConflict(draft.plan!) } : current);
        return;
      }
      const result = await api.fetchRemoteSourceWork(remote.source.id, remoteDetailActionCode(draft.detail), selectedPaths, selectedLocalPaths, "", draft.targetRoot || draft.plan.saveRoot, Object.values(draft.decisions));
      notifyFetchQueued(toast, result);
      setDraft(null);
      await onWorksChanged();
    } catch (error) {
      toast.notify(toastFromError(error, "Save failed."));
    } finally {
      setIsBusy(false);
    }
  };

  return {
    draft,
    tree,
    isBusy,
    open,
    selectEdition,
    save,
    close: () => setDraft(null),
    setTargetRoot: (targetRoot: string) => setDraft((current) => current ? { ...current, targetRoot, plan: null, message: "" } : current),
    setSelectedPaths: (paths: Set<string>) => setDraft((current) => current ? { ...current, selectedPaths: paths, plan: null, message: "" } : current),
    setSelectedLocalPaths: (paths: Set<string>) => setDraft((current) => current ? { ...current, selectedLocalPaths: paths, plan: null, message: "" } : current),
    setDecision: (decision: RemoteFetchFileDecision) => setDraft((current) => current ? {
      ...current,
      decisions: { ...current.decisions, [decision.itemKey]: decision },
      planDirty: true,
    } : current),
  };
}

function naturalCompare(left: string, right: string) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function remoteDetailActionCode(detail: RemoteWorkDetail) {
  return detail.remoteCode || detail.primaryCode || detail.remoteId;
}

function formatRemoteFetchPreparation(plan: RemoteWorkSavePlan) {
  if (hasRemoteFetchConflicts(plan)) return formatRemoteFetchPlanConflict(plan);
  const editions = plan.preparation?.editions.length ?? 0;
  const local = plan.localFiles.length;
  const warning = plan.preparation?.warnings[0];
  const summary = `Review ${editions || 1} language ${editions === 1 ? "edition" : "editions"}, ${local} local files, and the planned result before fetching.`;
  return warning ? `${summary} Metadata is ${plan.preparation.metadataStatus}: ${warning}` : summary;
}

function notifyFetchQueued(toast: ReturnType<typeof useToast>, result: RemoteWorkSaveResult) {
  toast.notify({
    kind: "success",
    message: result.deduplicated
      ? `Fetch was already queued as workflow run #${result.runId}.`
      : `Fetch queued for ${result.primaryCode} as workflow run #${result.runId}.`,
    actionLabel: "Activity",
    onAction: () => {
      window.history.pushState({}, "", `/activity?run=${result.runId}`);
      window.dispatchEvent(new Event("kikoto:navigation"));
    },
  });
}

import { useEffect, useState } from "react";

import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api } from "@/lib/api";

export type MediaDeleteTarget = {
  kind: "cache" | "local" | "local_root";
  locationId: number;
  title: string;
  path: string;
  sizeBytes: number | null;
};

export function useMediaCleanupWorkflow({
  onAccepted,
  onCompleted,
}: {
  onAccepted: () => void;
  onCompleted: () => Promise<void>;
}) {
  const toast = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || !activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status === "succeeded") {
      toast.success(`Delete workflow #${run.id} completed.`);
      void (async () => {
        try {
          await onCompleted();
        } catch (error) {
          toast.notify(toastFromError(error, "Deleted files, but work detail could not be refreshed."));
        }
      })();
      return;
    }
    toast.notify({
      kind: "error",
      message: `Delete workflow #${run.id} ${run.status}.`,
      actionLabel: "Activity",
      onAction: () => openActivityRun(run.id),
    });
  }, [activeRunId, onCompleted, toast, watchedRun.run]);

  const submit = async (targets: MediaDeleteTarget[]) => {
    if (targets.length === 0) return;
    setIsSubmitting(true);
    try {
      const orderedTargets = [...targets.filter((target) => target.kind !== "local_root"), ...targets.filter((target) => target.kind === "local_root")];
      const result = await api.cleanupMediaLocations(orderedTargets.map(({ kind, locationId }) => ({ kind, locationId })));
      setActiveRunId(result.runId);
      onAccepted();
      toast.notify({
        kind: "success",
        message: `Delete queued for ${targets.length} ${targets.length === 1 ? "item" : "items"} as workflow run #${result.runId}.`,
        actionLabel: "Activity",
        onAction: () => openActivityRun(result.runId),
      });
    } catch (error) {
      toast.notify(toastFromError(error, "Delete submission failed."));
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    activeRunId,
    isBusy: isSubmitting || Boolean(activeRunId),
    isSubmitting,
    runStatus: watchedRun.run?.status ?? "queued",
    submit,
  };
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/activity?run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

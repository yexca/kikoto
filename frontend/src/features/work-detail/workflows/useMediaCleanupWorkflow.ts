import { useEffect, useState } from "react";

import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api, type MediaCleanupMode } from "@/lib/api";

export type { MediaCleanupMode } from "@/lib/api";

export type MediaDeleteTarget = {
  kind: "cache" | "local" | "local_root";
  locationId: number;
  folderId?: number;
  expectedPath?: string;
  workId: number;
  title: string;
  path: string;
  sizeBytes: number | null;
};

export type MediaCleanupCompletion = {
  runId: number;
  mode: MediaCleanupMode;
  partial: boolean;
  workForgotten: boolean;
};

export function useMediaCleanupWorkflow({
  onAccepted,
  onCompleted,
}: {
  onAccepted: () => void;
  onCompleted: (completion: MediaCleanupCompletion) => Promise<void>;
}) {
  const toast = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || !activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status === "succeeded" || run.status === "partial") {
      const summary = parseCleanupSummary(run.summaryJson);
      const mode: MediaCleanupMode =
        summary.mode === "files_and_forget_work" ? "files_and_forget_work" : "files_only";
      const workForgotten = Boolean(
        summary.work_forgotten === true ||
          (typeof summary.forgotten_family_count === "number" && summary.forgotten_family_count > 0),
      );
      const completion: MediaCleanupCompletion = {
        runId: run.id,
        mode,
        partial: run.status === "partial",
        workForgotten,
      };
      if (completion.partial) {
        toast.notify({
          kind: "warning",
          message: `Files were deleted, but workflow #${run.id} kept the work because another source is still available.`,
          actionLabel: "Activity",
          onAction: () => openActivityRun(run.id),
        });
      } else if (workForgotten) {
        toast.success(`Files deleted and work forgotten in workflow #${run.id}.`);
      } else {
        toast.success(`Files deleted in workflow #${run.id}.`);
      }
      void (async () => {
        try {
          await onCompleted(completion);
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

  const submit = async (targets: MediaDeleteTarget[], mode: MediaCleanupMode = "files_only") => {
    if (targets.length === 0) return;
    setIsSubmitting(true);
    try {
      const orderedTargets = [
        ...targets.filter((target) => target.kind !== "local_root"),
        ...targets.filter((target) => target.kind === "local_root"),
      ];
      const result = await api.cleanupMediaLocations(
        orderedTargets.map(({ kind, locationId, folderId, expectedPath }) => ({
          kind,
          locationId,
          ...(folderId ? { folderId } : {}),
          ...(expectedPath ? { expectedPath } : {}),
        })),
        mode,
      );
      setActiveRunId(result.runId);
      onAccepted();
      toast.notify({
        kind: "success",
        message: `${mode === "files_and_forget_work" ? "Deletion and work-forget" : "File deletion"} queued for ${targets.length} ${targets.length === 1 ? "item" : "items"} as workflow run #${result.runId}.`,
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

function parseCleanupSummary(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/activity?run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

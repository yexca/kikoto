import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import type { WorkFolderEditResult } from "@/lib/api";

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?run=${runId}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

/**
 * Follows a queued folder edit to its result: announces that it was queued,
 * then reports how it ended and lets the page reload the folder.
 */
export function useFolderEditWorkflow({ onCompleted }: { onCompleted: () => Promise<void> }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || !activeRunId || run.id !== activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    if (run.status === "succeeded") {
      toast.success(t("folderEdit.completed", { runId: run.id }));
    } else {
      toast.notify({
        kind: "error",
        message: t("folderEdit.runEnded", { runId: run.id, status: run.status }),
        actionLabel: t("remoteFetch.activity"),
        onAction: () => openActivityRun(run.id),
      });
    }
    // A failed edit may have changed part of the folder, so reload either way.
    void onCompleted().catch((error: unknown) => {
      toast.notify(toastFromError(error, t("folderEdit.reloadFailed")));
    });
  }, [activeRunId, onCompleted, t, toast, watchedRun.run]);

  const accepted = (result: WorkFolderEditResult) => {
    setActiveRunId(result.runId);
    toast.notify({
      kind: "success",
      message: t("folderEdit.queued", { runId: result.runId }),
      actionLabel: t("remoteFetch.activity"),
      onAction: () => openActivityRun(result.runId),
    });
  };

  return { activeRunId, accepted };
}

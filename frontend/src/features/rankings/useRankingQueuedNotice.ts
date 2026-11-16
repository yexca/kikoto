import { useTranslation } from "react-i18next";

import { useToast } from "@/components/ui/toast";
import { openWorkflowPath, workflowRunPath, workflowsPath } from "@/features/workflows/workflowLinks";
import type { RankingRefreshRun } from "@/lib/api";

/**
 * Reports the pulls a refresh queued. An account that may open Activity gets
 * the run in the notice: the one run, or Activity's newest runs when the
 * refresh queued several (DLsite and each remote source pull on their own).
 */
export function useRankingQueuedNotice(canOpenRuns: boolean) {
  const { t } = useTranslation();
  const toast = useToast();
  return (runs: RankingRefreshRun[]) => {
    const message = t("subscriptions.rankings.refreshQueued");
    const ids = [...new Set(runs.map((run) => run.runId).filter((id) => id > 0))];
    if (!canOpenRuns || ids.length === 0) {
      toast.success(message);
      return;
    }
    const single = ids.length === 1;
    toast.notify({
      kind: "success",
      message,
      actionLabel: t(single ? "subscriptions.actions.viewRun" : "subscriptions.actions.viewRuns"),
      onAction: () => openWorkflowPath(single ? workflowRunPath(ids[0]) : workflowsPath()),
    });
  };
}

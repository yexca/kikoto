import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/useStableCallback";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { ApiError, type ShownWorksActionResult, type WorkflowRunDetail } from "@/lib/api";
import {
  EMPTY_SHOWN_WORKS_SOURCE_CHECK,
  mergeShownWorksSourceChecks,
  parseShownWorksSourceCheck,
  type ShownWorksSourceCheck,
} from "@/lib/shownWorksSourceCheck";

export type ShownWorksAction = "metadata" | "sources";

/** A queued run of an action and how many works it takes. */
export type ShownWorksActionRun = { runId: number; queued: number };

export type ShownWorksActions = ReturnType<typeof useShownWorksActions>;

/**
 * The actions on the works a Subscriptions view shows: syncing their metadata
 * and checking which remote sources have them. Each request queues a run for
 * the works that still need it and the hook follows the run; when it ends, the
 * view reloads and a toast reports the outcome. The source check's answers for
 * codes without a work last for this visit.
 */
export function useShownWorksActions({
  onSettled,
  onOpenRun,
}: {
  onSettled: () => void;
  onOpenRun: (runId: number) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [submitting, setSubmitting] = useState<ShownWorksAction | null>(null);
  const [metadata, setMetadata] = useState<ShownWorksActionRun | null>(null);
  const [sources, setSources] = useState<ShownWorksActionRun | null>(null);
  const [sourceCheck, setSourceCheck] = useState<ShownWorksSourceCheck>(EMPTY_SHOWN_WORKS_SOURCE_CHECK);
  const metadataRun = useWorkflowRunWatcher(metadata?.runId ?? null).run;
  const sourcesRun = useWorkflowRunWatcher(sources?.runId ?? null).run;
  const openRun = useStableCallback(onOpenRun);

  const viewRun = (runId: number) => ({
    actionLabel: t("subscriptions.actions.viewRun"),
    onAction: () => openRun(runId),
  });

  const start = async (action: ShownWorksAction, request: () => Promise<ShownWorksActionResult>) => {
    if (submitting || (action === "metadata" ? metadata : sources)) return;
    setSubmitting(action);
    try {
      const result = await request();
      if (result.runId <= 0) {
        toast.info(t(`subscriptions.actions.${action}.nothing`));
        return;
      }
      (action === "metadata" ? setMetadata : setSources)({ runId: result.runId, queued: result.queued });
      toast.notify({
        kind: "success",
        message: t(`subscriptions.actions.${action}.queued`, { count: result.queued }),
        ...viewRun(result.runId),
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "no_remote_source") {
        toast.warning(t("subscriptions.actions.sources.noSource"));
      } else {
        toast.notify(toastFromError(error, t(`subscriptions.actions.${action}.queueFailed`)));
      }
    } finally {
      setSubmitting(null);
    }
  };

  // The toast names the outcome; the details stay in the run.
  const settle = useStableCallback((action: ShownWorksAction, run: WorkflowRunDetail) => {
    const kind = run.status === "succeeded" ? "success" : run.status === "partial" ? "warning" : "error";
    const outcome = run.status === "succeeded" || run.status === "partial" ? run.status : "failed";
    toast.notify({ kind, message: t(`subscriptions.actions.${action}.${outcome}`), ...viewRun(run.id) });
    onSettled();
  });

  useEffect(() => {
    if (!metadata || !metadataRun || metadataRun.id !== metadata.runId || isActiveWorkflowStatus(metadataRun.status))
      return;
    setMetadata(null);
    settle("metadata", metadataRun);
  }, [metadata, metadataRun, settle]);

  useEffect(() => {
    if (!sources || !sourcesRun || sourcesRun.id !== sources.runId || isActiveWorkflowStatus(sourcesRun.status)) return;
    setSources(null);
    setSourceCheck((current) =>
      mergeShownWorksSourceChecks(current, parseShownWorksSourceCheck(sourcesRun.summaryJson)),
    );
    settle("sources", sourcesRun);
  }, [sources, sourcesRun, settle]);

  return {
    submitting,
    metadata,
    sources,
    sourceCheck,
    run: (action: ShownWorksAction, request: () => Promise<ShownWorksActionResult>) => void start(action, request),
  };
}

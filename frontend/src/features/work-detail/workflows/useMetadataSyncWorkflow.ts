import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, type WorkDetail } from "@/lib/api";
import { useAuth } from "@/auth/AuthProvider";
import { toastFromError, useToast } from "@/components/ui/toast";
import { isActiveWorkflowStatus, useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataSyncResultURL } from "@/lib/metadataMaintenance";

/**
 * Queues a metadata refresh for one work and follows its run. When the run
 * ends, the detail and the library reload and a toast links to the result.
 */
export function useMetadataSyncWorkflow({
  work,
  blocked,
  onWorkReload,
  onWorksChanged,
}: {
  work: WorkDetail | null;
  /** Another detail action is in flight; a refresh request is ignored. */
  blocked: boolean;
  onWorkReload: (workID: number, includeMedia?: boolean) => Promise<void>;
  onWorksChanged: () => Promise<void>;
}) {
  const auth = useAuth();
  const canViewActivity = auth.hasPermission("workflows:run");
  const toast = useToast();
  const { t } = useTranslation();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const watchedRun = useWorkflowRunWatcher(activeRunId);

  const sync = async (sourceId?: number) => {
    if (!work?.primaryCode || activeRunId || isSubmitting || blocked) return;
    setIsSubmitting(true);
    try {
      const result = await api.syncWorkMetadata(work.id, sourceId);
      if (result.runId <= 0 || result.status === "unavailable") {
        await onWorkReload(work.id, true);
        await onWorksChanged();
        toast.notify({
          kind: "warning",
          message: t("libraryDetail.metadataNotRecorded"),
        });
        return;
      }
      setActiveRunId(result.runId);
      toast.notify({
        kind: "success",
        message: result.deduplicated
          ? t("libraryDetail.metadataRefreshAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.metadataRefreshQueued", { code: result.primaryCode, runId: result.runId }),
        actionLabel: t(canViewActivity ? "workflowPage.viewRun" : "nav.workManagement"),
        onAction: () => {
          window.history.pushState({}, "", metadataSyncResultURL(result.runId, false, canViewActivity));
          window.dispatchEvent(new Event(NAVIGATION_EVENT));
        },
      });
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.metadataRefreshFailed")));
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    const run = watchedRun.run;
    if (!run || !activeRunId || isActiveWorkflowStatus(run.status)) return;
    setActiveRunId(null);
    const needsAttention = (run.metadataIssues?.pending ?? 0) > 0;
    const actionLabel = t(
      needsAttention ? "metadataIssues.openIssues" : canViewActivity ? "workflowPage.viewRun" : "nav.workManagement",
    );
    const onAction = () => {
      window.history.pushState({}, "", metadataSyncResultURL(run.id, needsAttention, canViewActivity));
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    };
    if (run.status === "succeeded" || run.status === "partial") {
      void (async () => {
        try {
          if (work) await onWorkReload(work.id, true);
          await onWorksChanged();
          toast.notify({
            kind: run.status === "succeeded" ? "success" : "warning",
            message: t("libraryDetail.metadataWorkflowStatus", { runId: run.id, status: run.status }),
            actionLabel,
            onAction,
          });
        } catch (error) {
          toast.notify(toastFromError(error, t("libraryDetail.metadataRefreshedReloadFailed")));
        }
      })();
      return;
    }
    toast.notify({
      kind: "error",
      message: t("libraryDetail.metadataWorkflowStatus", { runId: run.id, status: run.status }),
      actionLabel,
      onAction,
    });
  }, [activeRunId, watchedRun.run, canViewActivity, onWorkReload, onWorksChanged, t, toast, work]);

  return {
    /** A refresh request is being submitted. */
    isSubmitting,
    /** A refresh is being submitted or its run has not finished. */
    isBusy: isSubmitting || Boolean(activeRunId),
    sync,
    /** Follows a refresh run that another action queued for this work. */
    watchRun: setActiveRunId,
  };
}

import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { announceRemoteTrackCreated } from "@/app/remoteTrackWorkflows";
import {
  groupRemoteTargetsBySource,
  summarizeRemoteBulkRuns,
  type RemoteBulkAction,
  type RemoteWorkTarget,
} from "@/pages/remoteBulkRunModel";

export type { RemoteWorkTarget } from "@/pages/remoteBulkRunModel";

/** Translation keys a surface uses to report its bulk runs. */
export type RemoteBulkCopy = {
  fetchSummary: string;
  forkSummary: string;
  fetchFailed: string;
  forkFailed: string;
};

/**
 * Remote Fetch and Fork actions shared by the creator detail pages and the
 * Library remote source panel. Callers own their busy state and refresh.
 */
export function useRemoteWorkActions() {
  const { t } = useTranslation();
  const toast = useToast();

  /**
   * Records one bulk run per source and reports the combined result. `afterRuns`
   * refreshes the caller's view; its failure is reported like a run failure.
   */
  const recordBulkRuns = async (
    action: RemoteBulkAction,
    targets: readonly RemoteWorkTarget[],
    copy: RemoteBulkCopy,
    afterRuns: () => Promise<unknown>,
  ) => {
    try {
      const results = await Promise.all(
        groupRemoteTargetsBySource(targets).map((group) => api.recordRemoteBulkRun({ action, ...group })),
      );
      const summary = summarizeRemoteBulkRuns(results);
      const message = t(action === "fetch" ? copy.fetchSummary : copy.forkSummary, summary);
      if (summary.failed > 0) toast.warning(message);
      else toast.success(message);
      await afterRuns();
    } catch (error) {
      toast.notify(toastFromError(error, t(action === "fetch" ? copy.fetchFailed : copy.forkFailed)));
    }
  };

  /** Queues a Fork for one work and returns its run id, or null on failure. */
  const queueFork = async (target: RemoteWorkTarget, reason: string) => {
    try {
      const result = await api.trackRemoteSourceWork(target.sourceId, target.code, reason);
      announceRemoteTrackCreated(target.sourceId, target.code, result);
      toast.notify({
        kind: "info",
        message: result.deduplicated
          ? t("libraryDetail.forkAlreadyQueued", { runId: result.runId })
          : t("libraryDetail.forkQueued", { runId: result.runId }),
      });
      return result.runId;
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.forkQueueFailed")));
      return null;
    }
  };

  return { recordBulkRuns, queueFork };
}

export const creatorBulkCopy: RemoteBulkCopy = {
  fetchSummary: "creatorBrowse.bulkFetchSummary",
  forkSummary: "creatorBrowse.bulkForkSummary",
  fetchFailed: "creatorBrowse.bulkFetchFailed",
  forkFailed: "creatorBrowse.bulkForkFailed",
};

export const libraryBulkCopy: RemoteBulkCopy = {
  fetchSummary: "library.bulkFetchSummary",
  forkSummary: "library.bulkForkSummary",
  fetchFailed: "library.bulkFetchFailed",
  forkFailed: "library.bulkForkFailed",
};

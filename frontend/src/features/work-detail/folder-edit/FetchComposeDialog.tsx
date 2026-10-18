import { AlertTriangle, CloudDownload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { FetchComposeTarget, FolderEditResource } from "@/features/work-detail/folder-edit/folderEditModel";
import { FolderWorkspaceView } from "@/features/work-detail/folder-edit/FolderWorkspaceView";
import { useFetchComposeWorkspace } from "@/features/work-detail/folder-edit/useFetchComposeWorkspace";
import type { RemoteWorkSaveResult } from "@/lib/api";

/**
 * Fetches an edition into a new folder and builds the folder from several
 * places at once: the edition's own files, the files of other editions,
 * sources, and local folders, and lyrics of a declared language. The edition's
 * files are one Fetch; everything else is added to the folder once it exists.
 */
export function FetchComposeDialog({
  fetch,
  onClose,
  onApplied,
  onOpenStandardFetch,
}: {
  fetch: FetchComposeTarget;
  onClose: () => void;
  onApplied: (result: RemoteWorkSaveResult) => void | Promise<void>;
  /** Opens the single-edition Fetch, which reviews a destination folder. */
  onOpenStandardFetch: () => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const workspace = useFetchComposeWorkspace({
    fetch,
    canAssign: !auth.demoMode && auth.hasPermission("library:write"),
    onApplied: async (result, followUp) => {
      toast.notify({
        kind: "success",
        message: t(followUp ? "fetchCompose.queuedWithFollowUp" : "fetchCompose.queued", {
          code: result.primaryCode,
          runId: result.runId,
        }),
        actionLabel: t("remoteFetch.activity"),
        onAction: () => {
          window.history.pushState({}, "", `/workflows?activity=1&run=${result.runId}`);
          window.dispatchEvent(new Event("kikoto:navigation"));
        },
      });
      await onApplied(result);
    },
  });
  const hints = (resource: FolderEditResource) =>
    resource.id === workspace.primaryId
      ? t("fetchCompose.primaryHint", { source: resource.sourceName })
      : resource.kind === "local"
        ? t("fetchCompose.localHint")
        : t("fetchCompose.remoteHint", { source: resource.sourceName });
  const notice = workspace.fetchRoot?.conflict ? (
    <div
      role="alert"
      className="flex gap-2 rounded-md border border-warning-border bg-warning-surface px-2.5 py-2 text-xs text-warning-foreground"
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <div className="font-medium">{t("remoteFetch.fetchFolderReview")}</div>
        {workspace.fetchRoot.rootPath && <div className="break-all font-mono">{workspace.fetchRoot.rootPath}</div>}
        <div className="text-warning-foreground/80">{workspace.fetchRoot.message}</div>
        <Button variant="outline" size="sm" onClick={onOpenStandardFetch}>
          {t("fetchCompose.openStandardFetch")}
        </Button>
      </div>
    </div>
  ) : null;
  return (
    <FolderWorkspaceView
      workspace={workspace}
      title={t("fetchCompose.title")}
      description={t("fetchCompose.description", { code: fetch.editionCode })}
      icon={<CloudDownload className="h-4 w-4" />}
      marker="fetch-compose"
      hints={hints}
      notice={notice}
      emptyResult={t("fetchCompose.emptyResult")}
      statusIdle={t("fetchCompose.statusIdle")}
      statusReady={t("fetchCompose.statusReady", { count: workspace.addCount })}
      applyingLabel={t("fetchCompose.applying")}
      applyLabel={t("fetchCompose.apply")}
      initialPane="select"
      onClose={onClose}
      onApply={() => void workspace.apply()}
    />
  );
}

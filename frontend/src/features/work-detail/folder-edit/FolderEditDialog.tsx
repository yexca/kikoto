import { FolderCog } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { ConfirmMediaBatchDeleteDialog } from "@/features/work-detail/dialogs/ConfirmMediaBatchDeleteDialog";
import type { FolderEditResource, FolderEditTarget } from "@/features/work-detail/folder-edit/folderEditModel";
import { FolderWorkspaceView } from "@/features/work-detail/folder-edit/FolderWorkspaceView";
import {
  useFolderEditWorkspace,
  type FolderEditInitialRemote,
} from "@/features/work-detail/folder-edit/useFolderEditWorkspace";
import type { MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import type { MediaItem, WorkFolderEditResult } from "@/lib/api";

/**
 * Edits one local folder of a work in three columns: where files can come
 * from, the files of the chosen place, and the folder as it will be. The
 * edited folder is the first place; clearing a file there removes it.
 */
export function FolderEditDialog({
  workId,
  folder,
  currentItems,
  initialRemote,
  onBack,
  onClose,
  onApplied,
}: {
  workId: number;
  folder: { id: number; rootPath: string };
  currentItems: MediaItem[];
  initialRemote?: FolderEditInitialRemote | null;
  /** Returns to the folder's own file list. */
  onBack?: () => void;
  onClose: () => void;
  onApplied: (result: WorkFolderEditResult) => void;
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const target = useMemo<FolderEditTarget>(
    () => ({ workId, folderId: folder.id, rootPath: folder.rootPath }),
    [folder.id, folder.rootPath, workId],
  );
  const workspace = useFolderEditWorkspace({
    target,
    currentItems,
    initialRemote,
    canAssign: !auth.demoMode && auth.hasPermission("library:write"),
    onApplied,
  });
  const [confirmation, setConfirmation] = useState<{ step: 1 | 2; targets: MediaDeleteTarget[] } | null>(null);
  const removalTargets = useMemo<MediaDeleteTarget[]>(
    () =>
      workspace.removedFiles
        .filter((file) => file.locationId !== null)
        .map((file) => ({
          kind: "local",
          locationId: file.locationId!,
          workId,
          title: file.name,
          path: `${target.rootPath.replace(/\/+$/, "")}/${file.path}`,
          sizeBytes: file.sizeBytes,
        })),
    [target.rootPath, workId, workspace.removedFiles],
  );
  const startApply = () => {
    if (removalTargets.length > 0) setConfirmation({ step: 1, targets: removalTargets });
    else void workspace.apply();
  };
  const hints = (resource: FolderEditResource) =>
    resource.kind === "current"
      ? t("folderEdit.currentHint")
      : resource.kind === "local"
        ? t("folderEdit.localHint")
        : t("folderEdit.remoteHint", { source: resource.sourceName });

  return (
    <>
      <FolderWorkspaceView
        workspace={workspace}
        title={t("folderEdit.title")}
        description={t("folderEdit.description")}
        icon={<FolderCog className="h-4 w-4" />}
        marker="folder-edit"
        hints={hints}
        emptyResult={t("folderEdit.emptyResult")}
        statusIdle={t("folderEdit.statusIdle")}
        statusReady={t("folderEdit.statusReady", { add: workspace.addCount, remove: workspace.removeCount })}
        applyingLabel={t("folderEdit.applying")}
        applyLabel={t("folderEdit.apply")}
        initialPane={initialRemote ? "select" : "sources"}
        onBack={onBack}
        onClose={onClose}
        onApply={startApply}
      />
      {confirmation && (
        <ConfirmMediaBatchDeleteDialog
          targets={confirmation.targets}
          mode="files_only"
          step={confirmation.step}
          deleting={workspace.applying}
          onCancel={() => setConfirmation(null)}
          onContinue={() => setConfirmation({ ...confirmation, step: 2 })}
          onConfirm={() => {
            setConfirmation(null);
            void workspace.apply();
          }}
        />
      )}
    </>
  );
}

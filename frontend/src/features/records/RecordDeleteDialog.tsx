import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DeleteReviewDialog } from "@/components/delete-review";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, ApiError, type RecordAsset, type RecordFolder } from "@/lib/api";
import { usePlayer } from "@/player/PlayerProvider";

/** A Record file or folder whose deletion is under review. */
export type RecordDeleteTarget = { kind: "file"; asset: RecordAsset } | { kind: "folder"; folder: RecordFolder };

const refusalKeys: Record<string, string> = {
  record_asset_not_deletable: "records.delete.notDeletable",
  record_folder_not_deletable: "records.delete.folderNotDeletable",
  record_root_unavailable: "records.delete.rootUnavailable",
};

/**
 * Reviews the deletion of one Record file or folder in two steps and moves it
 * to the trash in the record root. A folder goes with everything in it. What
 * was deleted leaves the global player's queue. Only the path inside the
 * record root is shown.
 */
export function RecordDeleteDialog({
  target,
  onCancel,
  onDeleted,
}: {
  target: RecordDeleteTarget;
  onCancel: () => void;
  onDeleted: (target: RecordDeleteTarget) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const player = usePlayer();
  const [step, setStep] = useState<1 | 2>(1);
  const [deleting, setDeleting] = useState(false);
  const folder = target.kind === "folder";
  const name = folder ? target.folder.name : target.asset.name;
  const path = folder
    ? (target.folder.relativePath ?? target.folder.name)
    : (target.asset.relativePath ?? target.asset.name);

  const confirm = async () => {
    setDeleting(true);
    let removed: ReadonlySet<number>;
    try {
      if (folder) removed = new Set((await api.deleteRecordFolder(target.folder.id)).assetIds);
      else {
        await api.deleteRecordAsset(target.asset.id);
        removed = new Set([target.asset.id]);
      }
    } catch (error) {
      setDeleting(false);
      const key = error instanceof ApiError ? refusalKeys[error.code] : undefined;
      toast.notify(
        key ? { kind: "error", message: t(key) } : toastFromError(error, t("records.delete.failed", { name })),
      );
      return;
    }
    for (const track of player.queue) {
      if (track.record && removed.has(track.record.assetId) && track.queueItemId) {
        player.removeQueueItem(track.queueItemId);
      }
    }
    toast.success(t("records.delete.done", { name }));
    onDeleted(target);
  };

  return (
    <DeleteReviewDialog
      step={step}
      reviewTitle={t("records.delete.reviewTitle")}
      reviewDescription={t(folder ? "records.delete.folderReviewDescription" : "records.delete.reviewDescription")}
      confirmDescription={t("records.delete.confirmDescription")}
      summary={t(folder ? "records.delete.folderSummary" : "records.delete.summary", { name })}
      items={[{ key: `${target.kind}:${folder ? target.folder.id : target.asset.id}`, path }]}
      removed={
        folder
          ? [t("records.delete.removedFolder"), t("records.delete.removedFolderState")]
          : [t("records.delete.removedFile"), t("records.delete.removedState")]
      }
      kept={
        folder
          ? [t("records.delete.keptOtherFolders"), t("records.delete.keptFolderTrash")]
          : [t("records.delete.keptFolder"), t("records.delete.keptTrash")]
      }
      confirmLabel={t("records.delete.confirm")}
      deleting={deleting}
      onCancel={onCancel}
      onContinue={() => setStep(2)}
      onConfirm={() => void confirm()}
    />
  );
}

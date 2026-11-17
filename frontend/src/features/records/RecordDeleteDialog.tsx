import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DeleteReviewDialog } from "@/components/delete-review";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, ApiError, type RecordAsset } from "@/lib/api";
import { usePlayer } from "@/player/PlayerProvider";

import { recordTrackLocationId } from "./recordPlayerTrack";

/**
 * Reviews the deletion of one Record file in two steps and moves it to the
 * trash in the record root. The file leaves the global player's queue once it
 * is gone. Only the path inside the record root is shown.
 */
export function RecordDeleteDialog({
  asset,
  onCancel,
  onDeleted,
}: {
  asset: RecordAsset;
  onCancel: () => void;
  onDeleted: (asset: RecordAsset) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const player = usePlayer();
  const [step, setStep] = useState<1 | 2>(1);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      await api.deleteRecordAsset(asset.id);
    } catch (error) {
      setDeleting(false);
      const key =
        error instanceof ApiError && error.code === "record_asset_not_deletable"
          ? "records.delete.notDeletable"
          : error instanceof ApiError && error.code === "record_root_unavailable"
            ? "records.delete.rootUnavailable"
            : null;
      toast.notify(key ? { kind: "error", message: t(key) } : toastFromError(error, t("records.delete.failed")));
      return;
    }
    const locationId = recordTrackLocationId(asset.id);
    for (const track of player.queue) {
      if (track.record && track.locationId === locationId && track.queueItemId)
        player.removeQueueItem(track.queueItemId);
    }
    toast.success(t("records.delete.done", { name: asset.name }));
    onDeleted(asset);
  };

  return (
    <DeleteReviewDialog
      step={step}
      reviewTitle={t("records.delete.reviewTitle")}
      reviewDescription={t("records.delete.reviewDescription")}
      confirmDescription={t("records.delete.confirmDescription")}
      summary={t("records.delete.summary", { name: asset.name })}
      items={[{ key: String(asset.id), path: asset.relativePath ?? asset.name }]}
      removed={[t("records.delete.removedFile"), t("records.delete.removedState")]}
      kept={[t("records.delete.keptFolder"), t("records.delete.keptTrash")]}
      confirmLabel={t("records.delete.confirm")}
      deleting={deleting}
      onCancel={onCancel}
      onContinue={() => setStep(2)}
      onConfirm={() => void confirm()}
    />
  );
}

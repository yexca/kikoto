import { DeleteReviewDialog } from "@/components/delete-review";
import { mediaDeleteTargetKey } from "@/features/work-detail/dialogs/mediaDeleteTargets";
import { mediaDeleteTargetKindLabel } from "@/features/work-detail/dialogs/mediaFilePresentation";
import type { MediaCleanupMode, MediaDeleteTarget } from "@/features/work-detail/workflows/useMediaCleanupWorkflow";
import i18n from "@/i18n";

export function ConfirmMediaBatchDeleteDialog({
  targets,
  mode,
  step,
  deleting,
  onCancel,
  onContinue,
  onConfirm,
}: {
  targets: MediaDeleteTarget[];
  mode: MediaCleanupMode;
  step: 1 | 2;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  const forgetWork = mode === "files_and_forget_work";
  const localCount = targets.filter((target) => target.kind === "local").length;
  const cacheCount = targets.filter((target) => target.kind === "cache").length;
  const rootCount = targets.filter((target) => target.kind === "local_root").length;
  return (
    <DeleteReviewDialog
      step={step}
      reviewTitle={
        forgetWork ? i18n.t("libraryDetail.reviewDeletionForget") : i18n.t("libraryDetail.reviewFileDeletion")
      }
      reviewDescription={
        forgetWork
          ? i18n.t("libraryDetail.reviewDeletionForgetDescription")
          : i18n.t("libraryDetail.reviewDeletionFilesOnlyDescription")
      }
      confirmDescription={
        forgetWork ? i18n.t("libraryDetail.actionCannotUndoReview") : i18n.t("libraryDetail.deletedFilesCannotRestore")
      }
      summary={
        <>
          {i18n.t("libraryDetail.deleteSelectedLocations", { count: targets.length })}
          {localCount > 0 ? `, ${i18n.t("libraryDetail.includingLocal", { count: localCount })}` : ""}
          {cacheCount > 0 ? ` ${i18n.t("libraryDetail.includingCache", { count: cacheCount })}` : ""}
          {rootCount > 0 ? `, ${i18n.t("libraryDetail.includingWorkRoot")}` : ""}.
        </>
      }
      items={targets.map((target) => ({
        key: mediaDeleteTargetKey(target),
        label: mediaDeleteTargetKindLabel(target),
        path: target.path,
      }))}
      removed={[
        i18n.t("libraryDetail.selectedFilesLocations"),
        forgetWork ? i18n.t("libraryDetail.noSourceRemainsDeleted") : i18n.t("libraryDetail.noWorkLevelData"),
      ]}
      kept={
        forgetWork
          ? [i18n.t("libraryDetail.otherSourcesKept"), i18n.t("libraryDetail.sharedHistoryKept")]
          : [i18n.t("libraryDetail.playbackStateKept"), i18n.t("libraryDetail.metadataKept")]
      }
      notice={forgetWork ? i18n.t("libraryDetail.sourceStillAvailablePartial") : undefined}
      confirmLabel={forgetWork ? i18n.t("libraryDetail.deleteFilesForget") : i18n.t("libraryDetail.deleteFilesOnly")}
      deleting={deleting}
      onCancel={onCancel}
      onContinue={onContinue}
      onConfirm={onConfirm}
    />
  );
}

import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { mediaDeleteTargetKey } from "@/features/work-detail/dialogs/mediaDeleteTargets";
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
    <Dialog onClose={onCancel} layer="overlay-nested" size="lg" dismissible={!deleting}>
      <DialogHeader
        title={
          step === 1
            ? forgetWork
              ? i18n.t("libraryDetail.reviewDeletionForget")
              : i18n.t("libraryDetail.reviewFileDeletion")
            : i18n.t("workflowPage.finalConfirmation")
        }
        description={
          step === 1
            ? forgetWork
              ? i18n.t("libraryDetail.reviewDeletionForgetDescription")
              : i18n.t("libraryDetail.reviewDeletionFilesOnlyDescription")
            : forgetWork
              ? i18n.t("libraryDetail.actionCannotUndoReview")
              : i18n.t("libraryDetail.deletedFilesCannotRestore")
        }
        onClose={onCancel}
        closeLabel={i18n.t("content.close")}
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-error-foreground">
          {i18n.t("libraryDetail.deleteSelectedLocations", { count: targets.length })}
          {localCount > 0 ? `, ${i18n.t("libraryDetail.includingLocal", { count: localCount })}` : ""}
          {cacheCount > 0 ? ` ${i18n.t("libraryDetail.includingCache", { count: cacheCount })}` : ""}
          {rootCount > 0 ? `, ${i18n.t("libraryDetail.includingWorkRoot")}` : ""}.
        </div>
        <div className="app-scroll max-h-44 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {targets.slice(0, 10).map((target) => (
            <div key={mediaDeleteTargetKey(target)} className="flex gap-2 py-0.5">
              <span className="w-12 shrink-0 font-medium">{target.kind}</span>
              <span className="min-w-0 flex-1 truncate">{target.path}</span>
            </div>
          ))}
          {targets.length > 10 && (
            <div className="pt-1">{i18n.t("libraryDetail.moreCount", { count: targets.length - 10 })}</div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-md border border-error-border bg-error-surface p-3">
            <h4 className="font-semibold text-error-foreground">{i18n.t("libraryDetail.willBeDeleted")}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>{i18n.t("libraryDetail.selectedFilesLocations")}</li>
              {forgetWork ? (
                <li>{i18n.t("libraryDetail.noSourceRemainsDeleted")}</li>
              ) : (
                <li>{i18n.t("libraryDetail.noWorkLevelData")}</li>
              )}
            </ul>
          </section>
          <section className="rounded-md border bg-muted/30 p-3">
            <h4 className="font-semibold">{i18n.t("libraryDetail.willBeKept")}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {forgetWork ? (
                <>
                  <li>{i18n.t("libraryDetail.otherSourcesKept")}</li>
                  <li>{i18n.t("libraryDetail.sharedHistoryKept")}</li>
                </>
              ) : (
                <>
                  <li>{i18n.t("libraryDetail.playbackStateKept")}</li>
                  <li>{i18n.t("libraryDetail.metadataKept")}</li>
                </>
              )}
            </ul>
          </section>
        </div>
        {forgetWork && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
            {i18n.t("libraryDetail.sourceStillAvailablePartial")}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={deleting}>
          {i18n.t("content.cancel")}
        </Button>
        {step === 1 ? (
          <Button onClick={onContinue} disabled={targets.length === 0}>
            {i18n.t("libraryDetail.continue")}
          </Button>
        ) : (
          <Button variant="destructive" onClick={onConfirm} disabled={deleting || targets.length === 0}>
            <Trash2 className="h-4 w-4" />
            {deleting
              ? i18n.t("sources.refreshing")
              : forgetWork
                ? i18n.t("libraryDetail.deleteFilesForget")
                : i18n.t("libraryDetail.deleteFilesOnly")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

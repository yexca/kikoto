import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
  folderEditMergeCheckProgress,
  type FolderEditMergeCheckProgress,
} from "@/features/work-detail/folder-edit/folderEditModel";
import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";
import { api, type WorkFolderEditMerge, type WorkFolderEditMergeCheck, type WorkFolderEditRequest } from "@/lib/api";

/**
 * A check that still has files to compare is asked again for as long as it
 * gets further. The server hashes at least one file per round and keeps the
 * hashes, so a round can pass without a file compared only while it hashes
 * the candidates of one; this many such rounds in a row mean the check is stuck.
 */
const MAX_STALLED_ROUNDS = 5;
const SHOWN_LOST_FILES = 50;

type CheckState =
  | { status: "checking"; check: WorkFolderEditMergeCheck | null }
  | { status: "done"; check: WorkFolderEditMergeCheck }
  | { status: "failed" };

/**
 * Confirms merging local folders in two steps. The first compares every file
 * of the merged folders with the folder as the edit leaves it and lists the
 * files deleting the folders loses; the second confirms the deletion.
 */
export function FolderEditMergeConfirmDialog({
  workId,
  request,
  merges,
  removeCount,
  applying,
  onCancel,
  onConfirm,
}: {
  workId: number;
  request: WorkFolderEditRequest;
  merges: readonly WorkFolderEditMerge[];
  /** Files the same edit removes from the edited folder. */
  removeCount: number;
  applying: boolean;
  onCancel: () => void;
  /** Receives the request the check compared and the check's review. */
  onConfirm: (reviewed: { request: WorkFolderEditRequest; review: string }) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<1 | 2>(1);
  const [state, setState] = useState<CheckState>({ status: "checking", check: null });
  const [attempt, setAttempt] = useState(0);
  // The check covers the edit as it was when the dialog opened.
  const [checked] = useState(request);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      setState({ status: "checking", check: null });
      try {
        let furthest: FolderEditMergeCheckProgress | null = null;
        for (let stalled = 0; stalled < MAX_STALLED_ROUNDS;) {
          const check = await api.checkWorkFolderEditMerge(workId, checked, controller.signal);
          if (cancelled) return;
          if (check.complete && check.review) {
            setState({ status: "done", check });
            return;
          }
          setState({ status: "checking", check });
          const round = folderEditMergeCheckProgress(furthest, check);
          furthest = round.progress;
          stalled = round.advanced ? 0 : stalled + 1;
        }
        if (!cancelled) setState({ status: "failed" });
      } catch {
        if (!cancelled) setState({ status: "failed" });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, checked, workId]);

  const lost = state.status === "done" ? state.check.lost : [];
  const lostBytes = lost.reduce((sum, file) => sum + file.sizeBytes, 0);
  const fileCount = merges.reduce((sum, merge) => sum + merge.fileCount, 0);
  const comparesRemote = checked.additions.some((addition) => addition.kind === "remote");
  return (
    <Dialog onClose={onCancel} layer="overlay-nested" size="lg" dismissible={!applying}>
      <DialogHeader
        title={step === 1 ? t("folderEdit.mergeReview") : t("workflowPage.finalConfirmation")}
        description={step === 1 ? t("folderEdit.mergeReviewDescription") : t("folderEdit.mergeFinalDescription")}
        onClose={onCancel}
        closeLabel={t("content.close")}
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-error-foreground">
          {t("folderEdit.mergeDeletes", { count: merges.length, files: fileCount })}
          {removeCount > 0 ? ` ${t("folderEdit.mergeAlsoRemoves", { count: removeCount })}` : ""}
        </div>
        <ul className="app-scroll max-h-32 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {merges.map((merge) => (
            <li key={merge.folderId} className="flex gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono">{merge.rootPath}</span>
              <span className="shrink-0 tabular-nums">
                {t("folderEdit.mergeFolderFiles", { count: merge.fileCount })} · {formatBytes(merge.bytes)}
              </span>
            </li>
          ))}
        </ul>
        {state.status === "checking" && (
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>
              {state.check && state.check.pendingFiles > 0
                ? t("folderEdit.mergeCheckPending", {
                    count: state.check.pendingFiles,
                    size: formatBytes(state.check.pendingBytes),
                  })
                : t("folderEdit.mergeChecking")}
            </span>
          </div>
        )}
        {state.status === "failed" && (
          <div className="flex items-center gap-2 rounded-md border border-error-border px-3 py-2" role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0 text-error" />
            <span className="min-w-0 flex-1">{t("folderEdit.mergeCheckFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              {t("folderEdit.retry")}
            </Button>
          </div>
        )}
        {state.status === "done" &&
          (lost.length === 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-success-border bg-success-surface px-3 py-2 text-success-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t("folderEdit.mergeNoLoss")}</span>
            </div>
          ) : (
            <section className="space-y-2 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-warning-foreground">
              <div className="flex items-start gap-2 font-medium">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("folderEdit.mergeLost", { count: lost.length, size: formatBytes(lostBytes) })}</span>
              </div>
              <ul className="app-scroll max-h-44 overflow-auto rounded border bg-background/70 px-2 py-1 text-xs text-foreground">
                {lost.slice(0, SHOWN_LOST_FILES).map((file) => (
                  <li key={file.path} className="flex gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                      {file.path}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                  </li>
                ))}
                {lost.length > SHOWN_LOST_FILES && (
                  <li className="pt-1 text-muted-foreground">
                    {t("libraryDetail.moreCount", { count: lost.length - SHOWN_LOST_FILES })}
                  </li>
                )}
              </ul>
              <p className="text-xs">{t("folderEdit.mergeLostHint")}</p>
            </section>
          ))}
        {comparesRemote && <p className="text-xs text-muted-foreground">{t("folderEdit.mergeRemoteNote")}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={applying}>
          {t("content.cancel")}
        </Button>
        {step === 1 ? (
          <Button onClick={() => setStep(2)} disabled={state.status !== "done"}>
            {t("libraryDetail.continue")}
          </Button>
        ) : (
          <Button
            variant="destructive"
            onClick={() => {
              if (state.status === "done" && state.check.review)
                onConfirm({ request: checked, review: state.check.review });
            }}
            disabled={applying || state.status !== "done"}
          >
            <Trash2 className="h-4 w-4" />
            {lost.length > 0 ? t("folderEdit.mergeConfirmLoss", { count: lost.length }) : t("folderEdit.mergeConfirm")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

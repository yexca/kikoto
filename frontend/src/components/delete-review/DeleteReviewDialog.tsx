import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";

/** One file or folder a deletion removes, by the path the viewer knows it by. */
export type DeleteReviewItem = {
  key: string;
  /** A short kind, such as Local or Cache, before the path. */
  label?: string;
  path: string;
};

const visibleItems = 10;

/**
 * The two-step review before files are deleted: the first step lists what is
 * removed and what stays, the second asks once more before the destructive
 * action. The caller words each step; this dialog lays them out the same
 * everywhere.
 */
export function DeleteReviewDialog({
  step,
  reviewTitle,
  reviewDescription,
  confirmDescription,
  summary,
  items,
  removed,
  kept,
  notice,
  confirmLabel,
  deleting,
  onCancel,
  onContinue,
  onConfirm,
}: {
  step: 1 | 2;
  reviewTitle: string;
  reviewDescription: string;
  confirmDescription: string;
  /** The line above the list, such as how many files go. */
  summary: ReactNode;
  items: readonly DeleteReviewItem[];
  removed: readonly string[];
  kept: readonly string[];
  /** A warning under the lists, when the deletion may not go as far as asked. */
  notice?: ReactNode;
  confirmLabel: string;
  deleting: boolean;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const hiddenCount = Math.max(0, items.length - visibleItems);
  return (
    <Dialog onClose={onCancel} layer="overlay-nested" size="lg" dismissible={!deleting}>
      <DialogHeader
        title={step === 1 ? reviewTitle : t("workflowPage.finalConfirmation")}
        description={step === 1 ? reviewDescription : confirmDescription}
        onClose={onCancel}
        closeLabel={t("content.close")}
      />
      <DialogBody className="space-y-3 text-sm">
        <div className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-error-foreground">
          {summary}
        </div>
        <div className="app-scroll max-h-44 overflow-auto rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {items.slice(0, visibleItems).map((item) => (
            <div key={item.key} className="flex gap-2 py-0.5">
              {item.label && <span className="w-20 shrink-0 truncate font-medium">{item.label}</span>}
              <span className="min-w-0 flex-1 truncate">{item.path}</span>
            </div>
          ))}
          {hiddenCount ? <div className="pt-1">{t("libraryDetail.moreCount", { count: hiddenCount })}</div> : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <section className="rounded-md border border-error-border bg-error-surface p-3">
            <h4 className="font-semibold text-error-foreground">{t("libraryDetail.willBeDeleted")}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {removed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section className="rounded-md border bg-muted/30 p-3">
            <h4 className="font-semibold">{t("libraryDetail.willBeKept")}</h4>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              {kept.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>
        {notice && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
            {notice}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={deleting}>
          {t("content.cancel")}
        </Button>
        {step === 1 ? (
          <Button onClick={onContinue} disabled={items.length === 0}>
            {t("libraryDetail.continue")}
          </Button>
        ) : (
          <Button variant="destructive" onClick={onConfirm} disabled={deleting || items.length === 0}>
            <Trash2 className="h-4 w-4" />
            {deleting ? t("sources.refreshing") : confirmLabel}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

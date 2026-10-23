import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetadataFieldStatus } from "./metadataEditorModel";

export function MetadataFieldStatusBadge({ status }: { status: MetadataFieldStatus }) {
  const { t } = useTranslation();
  if (status === "source") return null;
  const variant = status === "edited" ? "info" : status === "reverting" ? "warning" : "secondary";
  return (
    <Badge variant={variant} className="shrink-0 px-1.5 py-0 text-[11px] font-medium">
      {t(`metadataEditor.status.${status}`)}
    </Badge>
  );
}

/**
 * One editable field: a single label row with its override status, where the
 * shown value comes from, and a revert action, then the control and an
 * optional hint. When the field offers an undo, a staged revert replaces the
 * control with a note and that undo action.
 */
export function MetadataEditorField({
  label,
  labelFor,
  labelBadges,
  status,
  source,
  revertLabel,
  onRevert,
  onUndoRevert,
  hint,
  children,
}: {
  label: string;
  labelFor?: string;
  labelBadges?: ReactNode;
  status: MetadataFieldStatus;
  /** Where an inherited value comes from, shown at the end of the label row. */
  source?: string;
  revertLabel?: string;
  onRevert?: () => void;
  onUndoRevert?: () => void;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const LabelTag = labelFor ? "label" : "span";
  return (
    <div role="group" aria-labelledby={labelId} className="min-w-0 space-y-1.5">
      <div className="flex min-h-7 items-center gap-2">
        <LabelTag id={labelId} htmlFor={labelFor} className="min-w-0 truncate text-sm font-medium">
          {label}
        </LabelTag>
        {labelBadges}
        <MetadataFieldStatusBadge status={status} />
        <span className="flex-1" />
        {source && (
          <span className="min-w-0 shrink-[100] truncate text-xs text-muted-foreground" title={source}>
            {source}
          </span>
        )}
        {status === "manual" && onRevert && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
            aria-label={revertLabel}
            title={revertLabel}
            onClick={onRevert}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("metadataEditor.revert")}
          </Button>
        )}
      </div>
      {status === "reverting" && onUndoRevert ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          <span className="min-w-0">{t("metadataEditor.revertPending")}</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onUndoRevert}>
            <Undo2 className="h-3.5 w-3.5" />
            {t("metadataEditor.undo")}
          </Button>
        </div>
      ) : (
        children
      )}
      {hint && !(status === "reverting" && onUndoRevert) && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export { SuggestionCombobox, type SuggestionOption } from "@/components/ui/suggestion-combobox";

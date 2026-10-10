import type { TFunction } from "i18next";
import { Check, Edit3, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Input } from "@/components/ui/input";
import { ageRatingPresentation, ageRatingValues, normalizeAgeRating } from "@/lib/ageRating";
import {
  editableSearchClauseKinds,
  type SearchClause,
  type SearchClauseDraft,
  type SearchClauseKind,
} from "@/lib/librarySearchClauses";

/** The clause being added, or the edited clause by its position in the query. */
export type SearchClauseEditorState = { mode: "add" | "edit"; index: number | null; draft: SearchClauseDraft };

/** The clauses of the search query as badges that open the editor or remove their clause. */
export function SearchClauseBadges({
  clauses,
  editor,
  onEdit,
  onRemove,
}: {
  clauses: SearchClause[];
  editor: SearchClauseEditorState | null;
  onEdit: (clause: SearchClause, index: number, anchor: HTMLElement) => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  if (clauses.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {clauses.map((clause, index) => (
        <Badge
          key={`${clause.kind}-${clause.value}-${index}`}
          variant={clause.kind === "exclude_tag" ? "warning" : "outline"}
          className="gap-1.5"
        >
          <button
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={(event) => onEdit(clause, index, event.currentTarget)}
            aria-haspopup="dialog"
            aria-expanded={editor?.mode === "edit" && editor.index === index}
          >
            <Edit3 className="h-3 w-3" />
            {searchClauseLabel(clause, t)}
          </button>
          <button
            className="rounded-sm text-muted-foreground hover:text-foreground"
            aria-label={t("library.removeSearchClause", { clause: searchClauseLabel(clause, t) })}
            onClick={() => onRemove(index)}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

export function SearchClauseEditor({
  editor,
  onChange,
  onCancel,
  onSave,
}: {
  editor: SearchClauseEditorState;
  onChange: (draft: SearchClauseDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const value = editor.draft.value;
  const title = editor.mode === "add" ? t("library.addSearchCondition") : t("library.editSearchCondition");
  const valueInputRef = useRef<HTMLInputElement>(null);
  // The popover stays hidden until it is positioned, so focus after that first layout.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => valueInputRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="grid gap-3 text-sm">
      <p className="font-medium">{title}</p>
      <div className="grid min-w-0 grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] items-center gap-2">
        <FloatingSelect
          value={editor.draft.kind}
          onValueChange={(nextValue) => {
            const kind = nextValue as SearchClauseKind;
            onChange({
              kind,
              value:
                kind === "shelf"
                  ? "true"
                  : kind === "age"
                    ? (normalizeAgeRating(editor.draft.value) ?? "general")
                    : editor.draft.kind === "shelf" || editor.draft.kind === "age"
                      ? ""
                      : editor.draft.value,
            });
          }}
          ariaLabel={t("library.searchClauseType")}
          className="w-full"
          options={editableSearchClauseKinds.map((kind) => ({
            value: kind.value,
            label: t(`library.searchClauseKinds.${kind.value}`, { defaultValue: kind.label }),
          }))}
        />
        {editor.draft.kind === "shelf" ? (
          <FloatingSelect
            value={value === "false" ? "false" : "true"}
            onValueChange={(nextValue) => onChange({ ...editor.draft, value: nextValue })}
            ariaLabel={t("library.shelfMembership")}
            className="w-full min-w-0"
            options={[
              { value: "true", label: t("library.included") },
              { value: "false", label: t("library.notIncluded") },
            ]}
          />
        ) : editor.draft.kind === "age" ? (
          <FloatingSelect
            value={normalizeAgeRating(value) ?? ""}
            onValueChange={(nextValue) => onChange({ ...editor.draft, value: nextValue })}
            ariaLabel={t("library.searchClauseKinds.age")}
            className="w-full min-w-0"
            options={ageRatingValues.map((rating) => ({ value: rating, label: ageRatingPresentation(rating).label }))}
          />
        ) : (
          <Input
            ref={valueInputRef}
            className="w-full min-w-0"
            value={value}
            onChange={(event) => onChange({ ...editor.draft, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSave();
            }}
            placeholder={t("library.value")}
          />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          <X className="h-4 w-4" />
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={!value.trim()} onClick={onSave}>
          <Check className="h-4 w-4" />
          {editor.mode === "add" ? t("library.add") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

function searchClauseLabel(clause: SearchClause, t?: TFunction) {
  const translate = (key: string, fallback: string) =>
    t?.(key, { value: clause.value, defaultValue: fallback }) ?? fallback;
  switch (clause.kind) {
    case "code":
      return translate("library.searchClauseLabels.code", `Code: ${clause.value}`);
    case "circle":
      return translate("library.searchClauseLabels.circle", `Circle: ${clause.value}`);
    case "exclude_circle":
      return translate("library.searchClauseLabels.excludeCircle", `Exclude circle: ${clause.value}`);
    case "voice_actor":
      return translate("library.searchClauseLabels.voiceActor", `VA: ${clause.value}`);
    case "exclude_voice_actor":
      return translate("library.searchClauseLabels.excludeVoiceActor", `Exclude VA: ${clause.value}`);
    case "tag":
      return translate("library.searchClauseLabels.tag", `Tag: ${clause.value}`);
    case "exclude_tag":
      return translate("library.searchClauseLabels.excludeTag", `Exclude tag: ${clause.value}`);
    case "user_tag":
      return translate("library.searchClauseLabels.userTag", `My tag: ${clause.value}`);
    case "exclude_user_tag":
      return translate("library.searchClauseLabels.excludeUserTag", `Exclude my tag: ${clause.value}`);
    case "rating_min":
      return translate("library.searchClauseLabels.ratingMin", `Rating >= ${clause.value}`);
    case "sales_min":
      return translate("library.searchClauseLabels.salesMin", `Sales >= ${clause.value}`);
    case "duration_min":
      return translate("library.searchClauseLabels.durationMin", `Duration >= ${clause.value}`);
    case "duration_max":
      return translate("library.searchClauseLabels.durationMax", `Duration <= ${clause.value}`);
    case "age": {
      const label = ageRatingPresentation(clause.value).label;
      return t?.("library.searchClauseLabels.age", { value: label, defaultValue: `Age: ${label}` }) ?? `Age: ${label}`;
    }
    case "language":
      return translate("library.searchClauseLabels.language", `Language: ${clause.value}`);
    case "shelf":
      return t
        ? t(
            clause.value === "false"
              ? "library.searchClauseLabels.shelfExcluded"
              : "library.searchClauseLabels.shelfIncluded",
          )
        : clause.value === "false"
          ? "Shelf: Not included"
          : "Shelf: Included";
    case "text":
    default:
      return translate("library.searchClauseLabels.text", `Text: ${clause.value}`);
  }
}

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/input";
import { MetadataEditorField } from "./MetadataEditorFields";
import { titleFieldStatus } from "./titleEditorModel";

/**
 * Edits the universal introduction. The field starts from the introduction the
 * work shows, like a title row: keeping or clearing an inherited introduction
 * leaves it inherited, and clearing a manual one restores the provider text.
 */
export function WorkDescriptionEditor({
  own,
  current,
  draft,
  onDraft,
}: {
  own?: string;
  current: string;
  draft?: string;
  onDraft: (description: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const hintId = useId();
  const status = titleFieldStatus(draft, own, current);
  return (
    <MetadataEditorField
      label={t("metadataEditor.universalDescription")}
      labelFor={id}
      status={status}
      revertLabel={t("metadataEditor.revertDescription")}
      onRevert={() => onDraft("")}
      hint={status === "reverting" ? t("metadataEditor.descriptionRevertHint") : undefined}
    >
      <p id={hintId} className="text-xs text-muted-foreground">
        {t("metadataEditor.universalDescriptionHint")}
      </p>
      <Textarea
        id={id}
        aria-describedby={hintId}
        rows={6}
        className="w-full resize-y"
        value={draft ?? current}
        placeholder={t("metadataEditor.noDescription")}
        onChange={(event) => onDraft(event.target.value)}
      />
    </MetadataEditorField>
  );
}

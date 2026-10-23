import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Textarea } from "@/components/ui/input";
import type { WorkDetail } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import { currentDescriptions, manualDescriptions, titleFieldStatus } from "./titleEditorModel";
import { metadataLanguageScopeLabel, scopeMatchesLanguage, type MetadataLanguageScope } from "./metadataLanguageScope";

type DescriptionDrafts = {
  work: WorkDetail;
  selectedMetadataVariantKey?: string;
  drafts: Record<string, string>;
  onDraft: (language: string, description: string) => void;
};

/**
 * One description row. It starts from the introduction its scope shows, like a
 * title row: keeping or clearing an inherited introduction leaves it inherited,
 * and clearing a manual one restores what the scope inherits.
 */
function DescriptionRow({
  work,
  selectedMetadataVariantKey = "",
  drafts,
  onDraft,
  language,
  label,
  rows,
  describedBy,
}: DescriptionDrafts & { language: string; label: string; rows: number; describedBy?: string }) {
  const { t } = useTranslation();
  const id = useId();
  const own = manualDescriptions(work.manualOverrides ?? {})[language];
  const current = currentDescriptions(work, selectedMetadataVariantKey)[language];
  const status = titleFieldStatus(drafts[language], own, current);
  return (
    <MetadataEditorField
      label={label}
      labelFor={id}
      status={status}
      revertLabel={
        language
          ? t("metadataEditor.revertDescriptionIn", { language: label })
          : t("metadataEditor.revertFallbackDescription")
      }
      onRevert={() => onDraft(language, "")}
      hint={status === "reverting" ? t("metadataEditor.descriptionRevertHint") : undefined}
    >
      <Textarea
        id={id}
        aria-describedby={describedBy}
        rows={rows}
        className="w-full resize-y"
        value={drafts[language] ?? current}
        placeholder={t("metadataEditor.noDescription")}
        onChange={(event) => onDraft(language, event.target.value)}
      />
    </MetadataEditorField>
  );
}

/**
 * Shows the descriptions of the selected language scope, like the titles:
 * every language lists each supported language and then the fallback that a
 * language without a description of its own shows, one language shows its own
 * row, and Fallback shows only the fallback.
 */
export function WorkDescriptionEditor({
  languageScope,
  ...props
}: DescriptionDrafts & { languageScope?: MetadataLanguageScope }) {
  const { t, i18n } = useTranslation();
  const fallbackHintId = useId();

  // Descriptions are saved only in the supported languages; another edition shows its provider introduction.
  if (languageScope?.kind === "other")
    return (
      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center text-sm font-medium">
          {metadataLanguageScopeLabel(languageScope, t, i18n.language)}
        </div>
        <p className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-dashed px-3 py-2 text-sm">
          {languageScope.variant?.description || t("metadataEditor.noDescription")}
        </p>
        <p className="text-xs text-muted-foreground">{t("metadataEditor.otherLanguageDescription")}</p>
      </div>
    );

  const all = !languageScope || languageScope.kind === "all";
  const visibleLanguages = all
    ? metadataTagNameLanguages
    : metadataTagNameLanguages.filter(([language]) => scopeMatchesLanguage(languageScope, language));
  const rows = all ? 3 : 10;
  return (
    <div className="grid gap-3">
      {visibleLanguages.map(([language, label]) => (
        <DescriptionRow key={language} {...props} language={language} label={t(label)} rows={rows} />
      ))}
      {(all || languageScope.kind === "fallback") && (
        <div className={visibleLanguages.length ? "space-y-1.5 border-t pt-3" : "space-y-1.5"}>
          <DescriptionRow
            {...props}
            language=""
            label={t("metadataEditor.fallback")}
            rows={rows}
            describedBy={fallbackHintId}
          />
          <p id={fallbackHintId} className="text-xs text-muted-foreground">
            {t("metadataEditor.fallbackDescriptionHint")}
          </p>
        </div>
      )}
    </div>
  );
}

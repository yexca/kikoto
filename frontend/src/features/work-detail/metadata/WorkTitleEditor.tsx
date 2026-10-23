import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { WorkDetail } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import {
  currentTitles,
  manualTitles,
  titleFieldStatus,
  titleLanguageMarkers,
  titleSourceLabel,
} from "./titleEditorModel";
import { resolveMetadataVariant } from "../metadataPresentationModel";
import { metadataLanguageScopeLabel, scopeMatchesLanguage, type MetadataLanguageScope } from "./metadataLanguageScope";

type TitleDrafts = {
  work: WorkDetail;
  drafts: Record<string, string>;
  onDraft: (language: string, title: string) => void;
};

/**
 * One title row. It starts with the title the language currently shows, so
 * editing starts from the existing text; keeping or clearing an inherited
 * title leaves it inherited.
 */
function TitleRow({
  work,
  drafts,
  onDraft,
  language,
  label,
  badges,
  describedBy,
}: TitleDrafts & { language: string; label: string; badges?: ReactNode; describedBy?: string }) {
  const { t } = useTranslation();
  const manual = manualTitles(work.manualOverrides ?? {});
  const current = currentTitles(work);
  const own = manual[language];
  const choice = work.titleChoices?.[language];
  const status = titleFieldStatus(drafts[language], own, current[language]);
  const sourceLabel = titleSourceLabel(language, manual, choice);
  const inherited = own ? (language ? manual[""] : undefined) : (choice?.title ?? manual[""] ?? work.title);
  const id = `work-title-${language || "all"}`;
  return (
    <MetadataEditorField
      label={label}
      labelFor={id}
      labelBadges={badges}
      status={status}
      source={own ? undefined : t("workTitles.source", { source: t(sourceLabel.key, sourceLabel.values) })}
      revertLabel={
        language ? t("metadataEditor.revertTitle", { language: label }) : t("metadataEditor.revertFallbackTitle")
      }
      onRevert={() => onDraft(language, "")}
      hint={status === "reverting" ? t("metadataEditor.titleRevertHint") : undefined}
    >
      <Input
        id={id}
        aria-describedby={describedBy}
        fieldSize="sm"
        className="w-full"
        value={drafts[language] ?? current[language]}
        placeholder={inherited || t("metadataEditor.inheritedTitle")}
        onChange={(event) => onDraft(language, event.target.value)}
      />
    </MetadataEditorField>
  );
}

/**
 * Shows the titles of the selected language scope: every language lists each
 * supported language and then the fallback title, one language shows its own
 * row, and Fallback shows only the fallback title that languages without a
 * manual title of their own show.
 */
export function WorkTitleEditor({
  work,
  selectedMetadataVariantKey = "",
  drafts,
  onDraft,
  languageScope,
}: TitleDrafts & {
  selectedMetadataVariantKey?: string;
  languageScope?: MetadataLanguageScope;
}) {
  const { t, i18n } = useTranslation();
  const fallbackDescriptionId = useId();
  const currentVariantKey = resolveMetadataVariant(work.metadataPresentation, selectedMetadataVariantKey)?.key;
  const markers = titleLanguageMarkers(work, selectedMetadataVariantKey);
  const badge = (text: string, variant: "outline" | "secondary") => (
    <Badge variant={variant} className="shrink-0 px-1.5 py-0 text-[11px] font-medium">
      {text}
    </Badge>
  );

  // Titles are saved only in the supported languages; another edition shows its provider title.
  if (languageScope?.kind === "other")
    return (
      <div className="space-y-1.5">
        <div className="flex min-h-7 flex-wrap items-center gap-2 text-sm font-medium">
          {metadataLanguageScopeLabel(languageScope, t, i18n.language)}
          {languageScope.variant?.key === currentVariantKey && badge(t("metadataEditor.currentLanguage"), "secondary")}
        </div>
        <p className="rounded-md border border-dashed px-3 py-2 text-sm">
          {languageScope.variant?.title || t("metadataEditor.inheritedTitle")}
        </p>
        <p className="text-xs text-muted-foreground">{t("metadataEditor.otherLanguageTitle")}</p>
      </div>
    );

  const visibleLanguages =
    languageScope && languageScope.kind !== "all"
      ? metadataTagNameLanguages.filter(([language]) =>
          scopeMatchesLanguage(languageScope, language, language === markers.origin),
        )
      : metadataTagNameLanguages;
  const showFallback = !languageScope || languageScope.kind === "all" || languageScope.kind === "fallback";

  return (
    <div className="grid gap-3">
      {visibleLanguages.map(([language, label]) => (
        <TitleRow
          key={language}
          work={work}
          drafts={drafts}
          onDraft={onDraft}
          language={language}
          label={t(label)}
          badges={
            <>
              {language === markers.origin && badge(t("metadataEditor.originLanguage"), "outline")}
              {language === markers.current && badge(t("metadataEditor.currentLanguage"), "secondary")}
            </>
          }
        />
      ))}
      {showFallback && (
        <div className={visibleLanguages.length ? "space-y-1.5 border-t pt-3" : "space-y-1.5"}>
          <TitleRow
            work={work}
            drafts={drafts}
            onDraft={onDraft}
            language=""
            label={t("metadataEditor.fallback")}
            describedBy={fallbackDescriptionId}
          />
          <p id={fallbackDescriptionId} className="text-xs text-muted-foreground">
            {t("metadataEditor.fallbackTitleDescription")}
          </p>
        </div>
      )}
    </div>
  );
}

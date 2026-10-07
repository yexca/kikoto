import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { WorkDetail } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import {
  currentTitles,
  manualTitles,
  titleFieldStatus,
  titleLanguageMarkers,
  titleSourceLabel,
} from "./titleEditorModel";

/**
 * Shows per-language titles first, with the universal title in advanced options.
 * Existing universal titles and drafts open those options for editing or reset.
 * Every row starts with the title it currently shows, so editing starts from
 * the existing text; keeping or clearing an inherited title leaves it inherited.
 */
export function WorkTitleEditor({
  work,
  selectedMetadataVariantKey = "",
  drafts,
  onDraft,
}: {
  work: WorkDetail;
  selectedMetadataVariantKey?: string;
  drafts: Record<string, string>;
  onDraft: (language: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const manual = manualTitles(work.manualOverrides ?? {});
  const current = currentTitles(work);
  const markers = titleLanguageMarkers(work, selectedMetadataVariantKey);
  const [allLanguages, ...languages] = metadataTagLanguages;
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(manual[""] || drafts[""]));
  const universalDescriptionId = useId();

  const row = ([language, label]: (typeof metadataTagLanguages)[number], labelKey: string = label) => {
    const own = manual[language];
    const choice = work.titleChoices?.[language];
    const status = titleFieldStatus(drafts[language], own, current[language]);
    const sourceLabel = titleSourceLabel(language, manual, choice);
    const inherited = own ? (language ? manual[""] : undefined) : (choice?.title ?? manual[""] ?? work.title);
    const id = `work-title-${language || "all"}`;
    return (
      <MetadataEditorField
        key={language}
        label={t(labelKey)}
        labelFor={id}
        labelBadges={
          language ? (
            <>
              {language === markers.origin && (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px] font-medium">
                  {t("metadataEditor.originLanguage")}
                </Badge>
              )}
              {language === markers.current && (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px] font-medium">
                  {t("metadataEditor.currentLanguage")}
                </Badge>
              )}
            </>
          ) : undefined
        }
        status={status}
        revertLabel={
          language
            ? t("metadataEditor.revertTitle", { language: t(labelKey) })
            : t("metadataEditor.revertUniversalTitle")
        }
        onRevert={() => onDraft(language, "")}
        hint={
          status === "reverting"
            ? t("metadataEditor.titleRevertHint")
            : own
              ? undefined
              : t("workTitles.source", { source: t(sourceLabel.key, sourceLabel.values) })
        }
      >
        <Input
          id={id}
          aria-describedby={language ? undefined : universalDescriptionId}
          fieldSize="sm"
          className="w-full"
          value={drafts[language] ?? current[language]}
          placeholder={inherited || t("metadataEditor.inheritedTitle")}
          onChange={(event) => onDraft(language, event.target.value)}
        />
      </MetadataEditorField>
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div>
          <h5 className="text-sm font-semibold">{t("metadataEditor.languageTitles")}</h5>
          <p className="text-xs text-muted-foreground">{t("metadataEditor.languageTitlesDescription")}</p>
        </div>
        <div className="grid gap-3">{languages.map((language) => row(language))}</div>
      </div>
      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="group border-t pt-2"
      >
        <summary
          role="button"
          aria-expanded={advancedOpen}
          className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
        >
          <ChevronRight
            className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            aria-hidden="true"
          />
          {t("metadataEditor.advancedTitles")}
        </summary>
        <div className="space-y-3 pt-2">
          <p id={universalDescriptionId} className="text-xs text-muted-foreground">
            {t("metadataEditor.universalTitleDescription")}
          </p>
          {row(allLanguages, "metadataEditor.universalTitle")}
        </div>
      </details>
    </div>
  );
}

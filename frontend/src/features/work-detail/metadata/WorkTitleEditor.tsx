import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import type { WorkDetail } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import { manualValueStatus } from "./metadataEditorModel";
import { manualTitles, titleSourceLabel } from "./titleEditorModel";

/**
 * Lists every title scope at once: the all-language title first, then one row
 * per display language. An empty row inherits, and its placeholder shows the
 * title it currently inherits.
 */
export function WorkTitleEditor({
  work,
  drafts,
  onDraft,
}: {
  work: WorkDetail;
  drafts: Record<string, string>;
  onDraft: (language: string, title: string) => void;
}) {
  const { t } = useTranslation();
  const manual = manualTitles(work.manualOverrides ?? {});
  const [allLanguages, ...languages] = metadataTagLanguages;

  const row = ([language, label]: (typeof metadataTagLanguages)[number]) => {
    const own = manual[language];
    const choice = work.titleChoices?.[language];
    const status = manualValueStatus(drafts[language], own);
    const sourceLabel = titleSourceLabel(language, manual, choice);
    const inherited = own ? (language ? manual[""] : undefined) : (choice?.title ?? manual[""] ?? work.title);
    const id = `work-title-${language || "all"}`;
    return (
      <MetadataEditorField
        key={language}
        label={t(label)}
        labelFor={id}
        status={status}
        revertLabel={t("metadataEditor.revertTitle", { language: t(label) })}
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
          fieldSize="sm"
          className="w-full"
          value={drafts[language] ?? own ?? ""}
          placeholder={inherited || t("metadataEditor.inheritedTitle")}
          onChange={(event) => onDraft(language, event.target.value)}
        />
      </MetadataEditorField>
    );
  };

  return (
    <div className="space-y-5">
      {row(allLanguages)}
      <div className="space-y-3">
        <div>
          <h5 className="text-sm font-semibold">{t("metadataEditor.languageTitles")}</h5>
          <p className="text-xs text-muted-foreground">{t("metadataEditor.languageTitlesDescription")}</p>
        </div>
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{languages.map(row)}</div>
      </div>
    </div>
  );
}

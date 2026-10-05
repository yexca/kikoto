import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkDetail } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";
import { manualTitles } from "./titleEditorModel";

export function WorkTitleEditor({
  work,
  language,
  drafts,
  onLanguage,
  onDraft,
  onReset,
}: {
  work: WorkDetail;
  language: string;
  drafts: Record<string, string>;
  onLanguage: (language: string) => void;
  onDraft: (language: string, title: string) => void;
  onReset: (language: string) => void;
}) {
  const { t } = useTranslation();
  const choice = work.titleChoices?.[language];
  const manual = manualTitles(work.manualOverrides ?? {});
  const source = manual[language]
    ? t(language ? "workTitles.manual" : "workTitles.manualAll")
    : manual[""]
      ? t("workTitles.manualAll")
      : choice?.source === "dlsite"
        ? t("workTitles.dlsite", { code: choice.code })
        : t("workTitles.original");
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>{t("workTitles.language")}</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={language}
          onChange={(event) => onLanguage(event.target.value)}
        >
          {metadataTagLanguages.map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t("libraryDetail.title")}</span>
        <Input
          className="w-full"
          value={drafts[language] ?? manual[language] ?? ""}
          placeholder={manual[language] ? "" : (choice?.title ?? manual[""] ?? work.title)}
          onChange={(event) => onDraft(language, event.target.value)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t("workTitles.source", { source })}</p>
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={!manual[language]} onClick={() => onReset(language)}>
          {t("libraryDetail.resetTitle")}
        </Button>
      </div>
    </div>
  );
}

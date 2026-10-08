import { useTranslation } from "react-i18next";
import { Gift } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { WorkDetail } from "@/lib/api";
import { languageLabel } from "../workDetailHelpers";
import { workVersionKindLabel, workVersionMediaState } from "../workVersionModel";
import { workFamilyEditions } from "./metadataEditorModel";

/**
 * Lists what belongs to this work's family: its language editions and the
 * purchase bonuses linked to any of them. It only reads the family; the
 * metadata link and purchase bonus sections above change it.
 */
export function MetadataEditorFamilySection({
  work,
}: {
  work: Pick<WorkDetail, "primaryCode" | "title" | "translations" | "purchaseBonuses">;
}) {
  const { t } = useTranslation();
  const editions = workFamilyEditions(work.translations ?? []);
  const bonuses = work.purchaseBonuses ?? [];
  const currentCode = work.primaryCode.trim().toUpperCase();
  return (
    <section className="space-y-2 border-t pt-4" aria-labelledby="metadata-editor-family">
      <div>
        <h3 id="metadata-editor-family" className="text-sm font-medium">
          {t("metadataEditor.family.title")}
        </h3>
        <p className="text-xs text-muted-foreground">{t("metadataEditor.family.description")}</p>
      </div>
      {editions.length === 0 ? (
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
          {t("metadataEditor.family.alone", { code: work.primaryCode })}
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card text-sm" aria-label={t("metadataEditor.family.editions")}>
          {editions.map((edition) => {
            const current = edition.primaryCode.trim().toUpperCase() === currentCode;
            return (
              <li key={edition.primaryCode} className="flex min-w-0 items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs font-semibold">{edition.primaryCode}</span>
                    <span className="text-xs text-muted-foreground">
                      {workVersionKindLabel(edition)} · {languageLabel(edition.metadataLanguage)}
                    </span>
                  </div>
                  {edition.title && (
                    <div className="truncate text-xs text-muted-foreground" title={edition.title}>
                      {edition.title}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {current && (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[11px] font-medium">
                      {t("metadataEditor.family.current")}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">{familyEditionState(edition, t)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {bonuses.length > 0 && (
        <ul className="divide-y rounded-md border bg-card text-sm" aria-label={t("metadataEditor.family.bonuses")}>
          {bonuses.map((bonus) => (
            <li key={bonus.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
              <Gift className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="shrink-0 font-mono text-xs font-semibold">{bonus.code}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={bonus.title}>
                {bonus.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{t("metadataEditor.family.bonus")}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function familyEditionState(edition: WorkDetail["translations"][number], t: (key: string) => string) {
  if (edition.localAvailable) return t("metadataEditor.family.local");
  return workVersionMediaState(edition) === "metadata_only" ? t("metadataEditor.family.metadataOnly") : "";
}

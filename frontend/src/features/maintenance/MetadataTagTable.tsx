import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { MetadataTag } from "@/lib/api";
import { metadataTagNameIn } from "@/lib/metadataTagModel";
import { interfaceLyricsLanguage } from "@/lib/translationTargets";
import {
  MetadataActionsCell,
  MetadataActionsHeader,
  MetadataManageButton,
  metadataBodyClassName,
  metadataHeadClassName,
  metadataRowClassName,
  metadataTableClassName,
} from "./MetadataEntryTable";

/**
 * Shared tags keyed by id, each named in the interface language. A tag
 * without a name of its own in that language shows the name it falls back to,
 * muted; the manage dialog holds every language's names.
 */
export function MetadataTagTable({ tags, onManage }: { tags: MetadataTag[]; onManage: (tag: MetadataTag) => void }) {
  const { t, i18n } = useTranslation();
  const language = interfaceLyricsLanguage(i18n.resolvedLanguage);
  return (
    <table className={metadataTableClassName} aria-label={t("metadataEntries.tags")}>
      <thead className={metadataHeadClassName}>
        <tr className="h-10">
          <th scope="col" className="w-28 py-2 pl-4 pr-3 font-medium">
            {t("metadataEntries.id")}
          </th>
          <th scope="col" className="px-3 py-2 font-medium">
            {t("metadataEntries.name")}
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            {t("metadataEntries.workCount")}
          </th>
          <MetadataActionsHeader />
        </tr>
      </thead>
      <tbody className={metadataBodyClassName}>
        {tags.map((tag) => {
          const name = metadataTagNameIn(tag, language);
          const status = tag.hidden ? "metadataEntries.hidden" : tag.mergedIntoTagId ? "metadataEntries.merged" : null;
          return (
            <tr key={tag.id} className={`${metadataRowClassName} align-top`}>
              <th scope="row" className="whitespace-nowrap py-3 pl-4 pr-3 font-medium tabular-nums">
                <span className="block">{tag.id}</span>
                {tag.dlsiteGenreId !== null && " "}
                {tag.dlsiteGenreId !== null && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t("metadataEntries.dlsiteGenreId", { id: tag.dlsiteGenreId })}
                  </span>
                )}
                {/* Only exceptions are named; an active tag needs no status. */}
                {status && " "}
                {status && (
                  <Badge variant="outline" className="mt-1 px-1.5 py-0 text-[11px] font-normal text-muted-foreground">
                    {t(status)}
                  </Badge>
                )}
              </th>
              <td
                lang={name.own ? language : undefined}
                className={name.own ? "px-3 py-3" : "px-3 py-3 text-muted-foreground"}
              >
                {name.name}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{tag.workCount}</td>
              <MetadataActionsCell>
                <MetadataManageButton
                  label={t("metadataEntries.manageFor", { name: tag.displayName })}
                  onClick={() => onManage(tag)}
                />
              </MetadataActionsCell>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

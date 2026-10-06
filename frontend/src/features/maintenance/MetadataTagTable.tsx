import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { MetadataTag } from "@/lib/api";
import { metadataTagLanguageName, metadataTagNameLanguages, otherMetadataTagNames } from "@/lib/metadataTagModel";
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
 * Shared tags keyed by id, with the name each language shows side by side, so
 * the list reads the same whatever language anyone prefers. The table scrolls
 * inside its box; the manage action stays pinned to the visible edge.
 */
export function MetadataTagTable({ tags, onManage }: { tags: MetadataTag[]; onManage: (tag: MetadataTag) => void }) {
  const { t } = useTranslation();
  return (
    <table className={metadataTableClassName} aria-label={t("metadataEntries.tags")}>
      <thead className={metadataHeadClassName}>
        <tr className="h-10">
          <th scope="col" className="py-2 pl-4 pr-3 font-medium">
            {t("metadataEntries.id")}
          </th>
          {metadataTagNameLanguages.map(([language, labelKey]) => (
            <th key={language} scope="col" className="min-w-28 px-3 py-2 font-medium">
              {t(labelKey)}
            </th>
          ))}
          <th scope="col" className="min-w-36 px-3 py-2 font-medium">
            {t("metadataEntries.otherNames")}
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            {t("metadataEntries.workCount")}
          </th>
          <MetadataActionsHeader />
        </tr>
      </thead>
      <tbody className={metadataBodyClassName}>
        {tags.map((tag) => {
          const others = otherMetadataTagNames(tag);
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
              {metadataTagNameLanguages.map(([language]) => {
                const name = metadataTagLanguageName(tag, language);
                const allLanguages = name?.language === "";
                return (
                  <td
                    key={language}
                    lang={name && !allLanguages ? language : undefined}
                    className={allLanguages ? "px-3 py-3 text-muted-foreground" : "px-3 py-3"}
                    title={allLanguages ? t("metadataEntries.allLanguages") : undefined}
                  >
                    {name?.name ?? <span className="text-muted-foreground/60">—</span>}
                  </td>
                );
              })}
              <td className="px-3 py-3 text-muted-foreground">
                {others.length ? (
                  <ul className="space-y-0.5">
                    {others.map((name) => {
                      const labelKey = metadataTagNameLanguages.find(([language]) => language === name.language)?.[1];
                      return (
                        <li key={`${name.language}:${name.name}`}>
                          <span lang={name.language || undefined}>{name.name}</span>
                          {labelKey && <span className="text-xs"> · {t(labelKey)}</span>}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <span className="text-muted-foreground/60">—</span>
                )}
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

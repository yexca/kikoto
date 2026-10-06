import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { MetadataTag } from "@/lib/api";
import { metadataTagLanguageName, metadataTagNameLanguages, otherMetadataTagNames } from "@/lib/metadataTagModel";

/**
 * Shared tags keyed by id, with the name each language shows side by side, so
 * the list reads the same whatever language anyone prefers. The table scrolls
 * inside its box; Manage stays pinned to the visible edge.
 */
export function MetadataTagTable({ tags, onManage }: { tags: MetadataTag[]; onManage: (tag: MetadataTag) => void }) {
  const { t } = useTranslation();
  return (
    <table className="w-full text-left text-sm" aria-label={t("metadataEntries.tags")}>
      <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
        <tr>
          <th className="px-3 py-2">{t("metadataEntries.id")}</th>
          {metadataTagNameLanguages.map(([language, labelKey]) => (
            <th key={language} className="min-w-28 px-3 py-2">
              {t(labelKey)}
            </th>
          ))}
          <th className="min-w-36 px-3 py-2">{t("metadataEntries.otherNames")}</th>
          <th className="px-3 py-2">{t("metadataEntries.workCount")}</th>
          <th className="sticky right-0 bg-card px-3 py-2">
            <span className="sr-only">{t("metadataEntries.manage")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tags.map((tag) => {
          const others = otherMetadataTagNames(tag);
          const status = tag.hidden ? "metadataEntries.hidden" : tag.mergedIntoTagId ? "metadataEntries.merged" : null;
          return (
            <tr key={tag.id} className="border-b align-top last:border-0">
              <th scope="row" className="whitespace-nowrap px-3 py-3 font-medium tabular-nums">
                <span className="block">{tag.id}</span>
                {tag.dlsiteGenreId !== null && " "}
                {tag.dlsiteGenreId !== null && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t("metadataEntries.dlsiteGenreId", { id: tag.dlsiteGenreId })}
                  </span>
                )}
                {/* Only exceptions are named; an active tag needs no status. */}
                {status && " "}
                {status && <span className="block text-xs font-normal text-muted-foreground">{t(status)}</span>}
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
                    {name?.name ?? <span className="text-muted-foreground">—</span>}
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
                  "—"
                )}
              </td>
              <td className="px-3 py-3 tabular-nums">{tag.workCount}</td>
              <td className="sticky right-0 bg-card px-3 py-3 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("metadataEntries.manageFor", { name: tag.displayName })}
                  onClick={() => onManage(tag)}
                >
                  {t("metadataEntries.manage")}
                </Button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

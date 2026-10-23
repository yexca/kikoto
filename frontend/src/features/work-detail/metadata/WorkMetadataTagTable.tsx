import { useTranslation } from "react-i18next";
import { Languages, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { metadataTagNameIn, metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";
import { MetadataTagNamesPanel } from "./MetadataTagNamesPanel";
import { metadataLanguageScopeLabel, type MetadataLanguageScope } from "./metadataLanguageScope";
import type { WorkMetadataTagsEditor } from "./useWorkMetadataTagsEditor";

const rowButtonClass =
  "relative grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type Tag = WorkMetadataTagsEditor["tags"][number];

/**
 * The tags on a work as a table with a column per language: every language
 * shows each supported language and the fallback name a language without its
 * own name shows, while one language or Fallback shows only that column. A
 * name a language inherits is muted. Each row's language button opens the
 * tag's names editor beneath it.
 */
export function WorkMetadataTagTable({
  editor,
  languageScope,
  namingId,
  onNaming,
}: {
  editor: WorkMetadataTagsEditor;
  languageScope?: MetadataLanguageScope;
  namingId: number | null;
  onNaming: (id: number | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const fallback = { language: "", label: t("metadataEditor.fallback") };
  const columns =
    !languageScope || languageScope.kind === "all"
      ? [...metadataTagNameLanguages.map(([language, label]) => ({ language, label: t(label) })), fallback]
      : languageScope.kind === "supported"
        ? [{ language: languageScope.language, label: metadataLanguageScopeLabel(languageScope, t, i18n.language) }]
        : languageScope.kind === "fallback"
          ? [fallback]
          : // Another edition's language has no saved tag names, so its tags show their fallback names.
            [{ language: "", label: metadataLanguageScopeLabel(languageScope, t, i18n.language) }];
  const editLanguage = languageScope?.kind === "supported" ? languageScope.language : "";
  const nameIn = (tag: Tag, language: string) =>
    language
      ? metadataTagNameIn(tag, language, editor.draftNames(tag.id))
      : { name: metadataTagNameIn(tag, "", editor.draftNames(tag.id)).name, own: true };
  // Row actions name a tag in the selected language, else by its display name.
  const rowName = (tag: Tag) => (editLanguage ? nameIn(tag, editLanguage).name : tag.displayName);

  return (
    <div className="app-scrollbar overflow-x-auto rounded-md border bg-card">
      <table className="w-full border-collapse text-sm" aria-label={t("metadataEntries.tags")}>
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th
                key={column.language || "fallback"}
                scope="col"
                className={cn(
                  "whitespace-nowrap px-3 py-2 text-left font-medium",
                  columns.length > 1 && "min-w-[6.5rem]",
                )}
              >
                {column.label}
              </th>
            ))}
            {/* Opaque, so names scrolling under the pinned actions do not show through. */}
            <th
              scope="col"
              className="sticky right-0 w-px bg-card px-1.5 py-2 [background-image:linear-gradient(hsl(var(--muted)/0.4),hsl(var(--muted)/0.4))]"
            >
              <span className="sr-only">{t("metadataEditor.tagActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {editor.tags.map((tag) => {
            const added = editor.isAdded(tag.id);
            const naming = namingId === tag.id;
            const name = rowName(tag);
            return [
              <tr key={tag.id} className={cn("border-t", added && "bg-primary/5")}>
                {columns.map((column, index) => {
                  const shown = nameIn(tag, column.language);
                  const Cell = index === 0 ? "th" : "td";
                  return (
                    <Cell
                      key={column.language || "fallback"}
                      scope={index === 0 ? "row" : undefined}
                      lang={shown.own && column.language ? column.language : undefined}
                      title={shown.own ? undefined : t("metadataEditor.tagNameInherited", { language: column.label })}
                      className={cn(
                        "px-3 py-2 text-left align-middle font-normal",
                        !shown.own && "text-muted-foreground",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 break-words">{shown.name}</span>
                        {index === 0 && added && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 px-1.5 py-0 text-[11px] font-medium"
                            title={t("metadataEditor.tagAdded")}
                          >
                            {t("metadataEditor.tagAddedBadge")}
                          </Badge>
                        )}
                      </span>
                    </Cell>
                  );
                })}
                <td className="sticky right-0 bg-card px-1.5 py-1">
                  <div className="flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      onClick={() => onNaming(naming ? null : tag.id)}
                      aria-label={t("metadataEditor.editTagNames", { name })}
                      aria-expanded={naming}
                      title={t("metadataEditor.editTagNames", { name })}
                      className={cn(rowButtonClass, naming && "bg-muted text-foreground")}
                    >
                      <Languages className="h-4 w-4" />
                      {editor.isRenamed(tag.id) && (
                        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary">
                          <span className="sr-only">{t("metadataEditor.unsavedMarker")}</span>
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        editor.remove(tag.id);
                        if (naming) onNaming(null);
                      }}
                      aria-label={t("metadataEntries.removeTag", { name })}
                      title={t("metadataEntries.removeTag", { name })}
                      className={rowButtonClass}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>,
              naming && (
                <tr key={`${tag.id}-names`} className="border-t">
                  <td colSpan={columns.length + 1} className="bg-muted/40 px-3 py-3">
                    <MetadataTagNamesPanel
                      tag={tag}
                      title={name}
                      language={editLanguage}
                      editor={editor}
                      onDone={() => onNaming(null)}
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

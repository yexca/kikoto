import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Languages, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMetadataEntrySuggestions } from "@/hooks/useMetadataEntrySuggestions";
import type { MetadataTag } from "@/lib/api";
import { exactMetadataTag, sameMetadataTagName } from "@/lib/metadataTagModel";
import { cn } from "@/lib/tailwindClassNames";
import { MetadataEditorField, SuggestionCombobox } from "./MetadataEditorFields";
import { MetadataTagNamesPanel } from "./MetadataTagNamesPanel";
import type { MetadataFieldStatus } from "./metadataEditorModel";
import type { WorkMetadataTagsEditor } from "./useWorkMetadataTagsEditor";

export function WorkMetadataTagsSection({ editor }: { editor: WorkMetadataTagsEditor }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [namingId, setNamingId] = useState<number | null>(null);
  const naming = editor.tags.find((tag) => tag.id === namingId);
  const suggestions = useMetadataEntrySuggestions("tags", query);
  const add = (tag: MetadataTag) => {
    if (tag.resolvedHidden) return;
    editor.add(tag);
    setQuery("");
  };
  const existing = exactMetadataTag(suggestions.entries as MetadataTag[], query);
  const alreadyAdded = editor.tags.some((tag) => sameMetadataTagName(tag.displayName, query));
  const create = () => {
    if (existing) add(existing);
    else if (!alreadyAdded) {
      editor.stage(query);
      setQuery("");
    }
  };
  const status: MetadataFieldStatus = editor.changed ? "edited" : editor.hasOverrides ? "manual" : "source";
  if (editor.failed)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {t("metadataEntries.loadFailed")}
        <Button variant="outline" size="sm" onClick={editor.retry}>
          {t("metadataEntries.retry")}
        </Button>
      </div>
    );
  if (!editor.ready) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  const options = suggestions.entries
    .filter((entry) => !editor.tags.some((tag) => tag.id === entry.id))
    .map((entry) => {
      const tag = entry as MetadataTag;
      return {
        key: String(tag.id),
        label: tag.resolvedHidden ? `${tag.displayName} · ${t("metadataEntries.hidden")}` : tag.displayName,
        disabled: tag.resolvedHidden,
        onSelect: () => add(tag),
      };
    });
  if (query.trim() && !existing && !alreadyAdded)
    options.push({
      key: "create",
      label: `${t("metadataEntries.createTag")}: ${query.trim()}`,
      disabled: false,
      onSelect: create,
    });
  return (
    <div className="space-y-4">
      <MetadataEditorField label={t("metadataEntries.tags")} status={status}>
        <ul className="flex flex-wrap gap-1.5" aria-label={t("metadataEntries.tags")}>
          {editor.tags.map((tag) => {
            const added = editor.isAdded(tag.id);
            return (
              <li
                key={tag.id}
                className={cn(
                  "inline-flex max-w-full items-center gap-1 rounded-md border py-0.5 pl-2 pr-0.5 text-sm",
                  added ? "border-primary/40 bg-primary/5" : "bg-card",
                )}
                title={added ? t("metadataEditor.tagAdded") : undefined}
              >
                <span className="min-w-0 truncate">{tag.displayName}</span>
                <button
                  type="button"
                  onClick={() => setNamingId(namingId === tag.id ? null : tag.id)}
                  aria-label={t("metadataEditor.editTagNames", { name: tag.displayName })}
                  aria-expanded={namingId === tag.id}
                  title={t("metadataEditor.editTagNames", { name: tag.displayName })}
                  className={cn(
                    "relative grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
                    namingId === tag.id && "bg-muted text-foreground",
                  )}
                >
                  <Languages className="h-3.5 w-3.5" />
                  {editor.isRenamed(tag.id) && (
                    <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary">
                      <span className="sr-only">{t("metadataEditor.unsavedMarker")}</span>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    editor.remove(tag.id);
                    if (namingId === tag.id) setNamingId(null);
                  }}
                  aria-label={t("metadataEntries.removeTag", { name: tag.displayName })}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            );
          })}
          {!editor.tags.length && <li className="text-sm text-muted-foreground">{t("metadataEntries.noTags")}</li>}
        </ul>
        {naming && (
          <div className="mt-3">
            <MetadataTagNamesPanel key={naming.id} tag={naming} editor={editor} onDone={() => setNamingId(null)} />
          </div>
        )}
      </MetadataEditorField>
      <div className="space-y-1.5">
        <label htmlFor="metadata-editor-tag" className="block text-sm font-medium">
          {t("metadataEntries.addTag")}
        </label>
        <SuggestionCombobox
          id="metadata-editor-tag"
          value={query}
          placeholder={t("metadataEditor.searchTags")}
          onChange={setQuery}
          onSubmitText={create}
          options={options}
          footer={
            (existing?.resolvedHidden || suggestions.failed) && (
              <>
                {existing?.resolvedHidden && (
                  <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
                    {t("metadataEntries.hiddenNameConflict")}
                  </p>
                )}
                {suggestions.failed && (
                  <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
                    {t("metadataEntries.loadFailed")}
                  </p>
                )}
              </>
            )
          }
        />
        <p className="text-xs text-muted-foreground">{t("metadataEditor.tagHint")}</p>
      </div>
      {editor.canRestore && (
        <Button variant="ghost" size="sm" className="gap-1 px-2 text-muted-foreground" onClick={editor.restore}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("metadataEntries.restoreTags")}
        </Button>
      )}
    </div>
  );
}

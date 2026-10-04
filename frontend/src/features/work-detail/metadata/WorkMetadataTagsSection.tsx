import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMetadataEntrySuggestions } from "@/hooks/useMetadataEntrySuggestions";
import {
  api,
  type EffectiveMetadataTag,
  type MetadataTag,
  type MetadataTagOverride,
  type WorkMetadataTags,
} from "@/lib/api";
import {
  changeMetadataTagOverride,
  metadataTagOverrideKey,
  exactMetadataTag,
  sameMetadataTagName,
} from "@/lib/metadataTagModel";

export function useWorkMetadataTagsEditor(workId: number) {
  const [initial, setInitial] = useState<WorkMetadataTags | null>(null);
  const [tags, setTags] = useState<EffectiveMetadataTag[]>([]);
  const [overrides, setOverrides] = useState<MetadataTagOverride[]>([]);
  const [failed, setFailed] = useState(false);
  const [drafts, setDrafts] = useState<{ id: number; name: string }[]>([]);
  const nextDraftID = useRef(-1);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getWorkMetadataTags(workId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setInitial(result);
        setTags(result.tags);
        setOverrides(result.overrides);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [workId, reload]);
  const changed =
    initial !== null &&
    (drafts.length > 0 || metadataTagOverrideKey(initial.overrides) !== metadataTagOverrideKey(overrides));
  return {
    tags,
    failed,
    ready: initial !== null,
    changed,
    retry: () => setReload((value) => value + 1),
    add: (tag: MetadataTag) => {
      setOverrides((current) => changeMetadataTagOverride(current, tag.id, "add"));
      setTags((current) =>
        current.some((entry) => entry.id === tag.id)
          ? current
          : [...current, { id: tag.id, displayName: tag.displayName, source: "manual" }],
      );
    },
    stage: (name: string) => {
      name = name.trim();
      if (!name || tags.some((tag) => sameMetadataTagName(tag.displayName, name))) return;
      const id = nextDraftID.current--;
      setDrafts((current) => [...current, { id, name }]);
      setTags((current) => [...current, { id, displayName: name, source: "manual" }]);
    },
    remove: (id: number) => {
      if (id < 0) setDrafts((current) => current.filter((tag) => tag.id !== id));
      else setOverrides((current) => changeMetadataTagOverride(current, id, "remove"));
      setTags((current) => current.filter((tag) => tag.id !== id));
    },
    restore: () => {
      setDrafts([]);
      setOverrides([]);
      setTags(initial?.inheritedTags ?? []);
    },
    save: async () => {
      if (!changed) return;
      const result = await api.setWorkMetadataTags(
        workId,
        overrides,
        drafts.map((tag) => tag.name),
      );
      setDrafts([]);
      setInitial(result);
      setTags(result.tags);
      setOverrides(result.overrides);
    },
  };
}

export function WorkMetadataTagsSection({
  editor,
  saving,
}: {
  editor: ReturnType<typeof useWorkMetadataTagsEditor>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const suggestions = useMetadataEntrySuggestions("tags", query);
  const add = (tag: MetadataTag) => {
    editor.add(tag);
    setQuery("");
  };
  const existing = exactMetadataTag(suggestions.entries as MetadataTag[], query);
  const create = () => {
    if (existing) add(existing);
    else {
      editor.stage(query);
      setQuery("");
    }
  };
  if (editor.failed)
    return (
      <div role="alert" className="text-sm text-muted-foreground">
        {t("metadataEntries.loadFailed")}{" "}
        <Button variant="outline" size="sm" onClick={editor.retry}>
          {t("metadataEntries.retry")}
        </Button>
      </div>
    );
  if (!editor.ready) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  return (
    <fieldset disabled={saving} className="min-w-0 space-y-3 border-0 p-0">
      <div className="flex flex-wrap gap-2" aria-label={t("metadataEntries.tags")}>
        {editor.tags.map((tag) => (
          <span key={tag.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
            {tag.displayName}
            <button
              type="button"
              onClick={() => editor.remove(tag.id)}
              aria-label={t("metadataEntries.removeTag", { name: tag.displayName })}
              className="rounded p-1 hover:bg-accent"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {!editor.tags.length && <p className="text-sm text-muted-foreground">{t("metadataEntries.noTags")}</p>}
      </div>
      <label className="block space-y-1 text-sm">
        <span className="block">{t("metadataEntries.addTag")}</span>
        <Input className="w-full" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {query.trim() && (
        <div className="space-y-1 rounded-md border p-2">
          {suggestions.entries
            .filter((entry) => !editor.tags.some((tag) => tag.id === entry.id))
            .map((entry) => (
              <Button key={entry.id} variant="ghost" size="sm" onClick={() => add(entry as MetadataTag)}>
                {entry.displayName}
              </Button>
            ))}
          {suggestions.failed && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t("metadataEntries.loadFailed")}
            </p>
          )}
          {!existing && !editor.tags.some((tag) => sameMetadataTagName(tag.displayName, query)) && (
            <Button variant="outline" size="sm" onClick={create}>
              {t("metadataEntries.createTag")}: {query.trim()}
            </Button>
          )}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={editor.restore}>
        {t("metadataEntries.restoreTags")}
      </Button>
    </fieldset>
  );
}

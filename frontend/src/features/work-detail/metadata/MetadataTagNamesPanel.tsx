import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useStableCallback } from "@/hooks/useStableCallback";
import type { EffectiveMetadataTag } from "@/lib/api";
import { metadataTagLanguages, providerMetadataTagName } from "@/lib/metadataTagModel";
import { MetadataEditorField } from "./MetadataEditorFields";
import { manualValueStatus } from "./metadataEditorModel";
import type { WorkMetadataTagsEditor } from "./useWorkMetadataTagsEditor";

/**
 * Edits one tag's name in every language inside its list row. A
 * shared tag's names apply to every work with that tag; a new tag's typed name
 * is its all-language name and its other names are created with it. Under one
 * language it shows that language's name first, then the all-language name it
 * falls back to.
 */
export function MetadataTagNamesPanel({
  tag,
  title = tag.displayName,
  language = "",
  editor,
  onDone,
}: {
  tag: EffectiveMetadataTag;
  /** The tag's name as its chip shows it. */
  title?: string;
  /** A supported language to edit alone; empty lists every language. */
  language?: string;
  editor: WorkMetadataTagsEditor;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const isNew = tag.id < 0;
  const shownLanguages = language
    ? [...metadataTagLanguages].filter(([value]) => value === language || value === "").reverse()
    : metadataTagLanguages;
  // The all-language name is the fallback a language without its own name shows.
  const nameLabel = (language: string, label: string) => (language ? t(label) : t("metadataEditor.fallback"));
  const detail = editor.detail(tag.id);
  const loadDetail = useStableCallback(editor.loadDetail);
  // Load once per opened tag; a failed load offers its own retry.
  useEffect(() => {
    if (!isNew) loadDetail(tag.id);
  }, [tag.id, isNew, loadDetail]);

  const rows = () => {
    if (isNew)
      return shownLanguages.map(([language, label]) =>
        language ? (
          <NameRow
            key={language}
            id={`tag-name-${tag.id}-${language}`}
            label={nameLabel(language, label)}
            value={editor.nameValue(tag.id, language)}
            status={manualValueStatus(editor.nameValue(tag.id, language), undefined)}
            placeholder={tag.displayName}
            onChange={(value) => editor.setName(tag.id, language, value)}
          />
        ) : (
          <div key="all" className="min-w-0 space-y-1.5">
            <div className="flex min-h-7 items-center text-sm font-medium">{nameLabel(language, label)}</div>
            <p className="flex h-9 items-center truncate rounded-md border border-dashed px-3 text-sm">
              {tag.displayName}
            </p>
          </div>
        ),
      );
    if (!detail || detail.status === "loading")
      return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
    if (detail.status === "failed")
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground sm:col-span-2">
          {t("metadataEntries.loadFailed")}
          <Button variant="outline" size="sm" onClick={() => loadDetail(tag.id)}>
            {t("metadataEntries.retry")}
          </Button>
        </div>
      );
    return shownLanguages.map(([language, label]) => {
      const own = editor.savedName(tag.id, language);
      return (
        <NameRow
          key={language}
          id={`tag-name-${tag.id}-${language || "all"}`}
          label={nameLabel(language, label)}
          value={editor.nameValue(tag.id, language)}
          status={manualValueStatus(editor.draftName(tag.id, language), own)}
          placeholder={providerMetadataTagName(detail.tag, language) ?? (language ? "" : detail.tag.displayName)}
          revertLabel={t("metadataEditor.revertTagName", { language: nameLabel(language, label) })}
          onChange={(value) => editor.setName(tag.id, language, value)}
        />
      );
    });
  };

  return (
    <section aria-label={t("metadataEditor.tagNamesFor", { name: title })} className="space-y-3">
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{rows()}</div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {isNew
            ? t("metadataEditor.tagNamesNew")
            : detail?.status === "ready"
              ? t("metadataEditor.tagNamesShared", { count: detail.tag.workCount })
              : t("metadataEditor.tagNamesSharedUnknown")}
        </p>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onDone}>
          {t("metadataEditor.tagNamesDone")}
        </Button>
      </div>
    </section>
  );
}

function NameRow({
  id,
  label,
  value,
  status,
  placeholder,
  revertLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  status: ReturnType<typeof manualValueStatus>;
  placeholder?: string;
  revertLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <MetadataEditorField
      label={label}
      labelFor={id}
      status={status}
      revertLabel={revertLabel}
      onRevert={revertLabel ? () => onChange("") : undefined}
    >
      <Input
        id={id}
        fieldSize="sm"
        className="w-full"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </MetadataEditorField>
  );
}

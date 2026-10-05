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
 * Edits one tag's name in every language, laid out like the title rows. A
 * shared tag's names apply to every work with that tag; a new tag's typed name
 * is its all-language name and its other names are created with it.
 */
export function MetadataTagNamesPanel({
  tag,
  editor,
  onDone,
}: {
  tag: EffectiveMetadataTag;
  editor: WorkMetadataTagsEditor;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const isNew = tag.id < 0;
  const detail = editor.detail(tag.id);
  const loadDetail = useStableCallback(editor.loadDetail);
  // Load once per opened tag; a failed load offers its own retry.
  useEffect(() => {
    if (!isNew) loadDetail(tag.id);
  }, [tag.id, isNew, loadDetail]);

  const rows = () => {
    if (isNew) {
      const [allLanguages, ...languages] = metadataTagLanguages;
      return (
        <>
          <div className="min-w-0 space-y-1.5">
            <div className="flex min-h-7 items-center text-sm font-medium">{t(allLanguages[1])}</div>
            <p className="flex h-9 items-center truncate rounded-md border border-dashed px-3 text-sm">
              {tag.displayName}
            </p>
          </div>
          {languages.map(([language, label]) => (
            <NameRow
              key={language}
              id={`tag-name-${tag.id}-${language}`}
              label={t(label)}
              value={editor.nameValue(tag.id, language)}
              status={manualValueStatus(editor.nameValue(tag.id, language), undefined)}
              placeholder={tag.displayName}
              onChange={(value) => editor.setName(tag.id, language, value)}
            />
          ))}
        </>
      );
    }
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
    return metadataTagLanguages.map(([language, label]) => {
      const own = editor.savedName(tag.id, language);
      return (
        <NameRow
          key={language}
          id={`tag-name-${tag.id}-${language || "all"}`}
          label={t(label)}
          value={editor.nameValue(tag.id, language)}
          status={manualValueStatus(editor.draftName(tag.id, language), own)}
          placeholder={providerMetadataTagName(detail.tag, language) ?? (language ? "" : detail.tag.displayName)}
          revertLabel={t("metadataEditor.revertTagName", { language: t(label) })}
          onChange={(value) => editor.setName(tag.id, language, value)}
        />
      );
    });
  };

  return (
    <section
      aria-label={t("metadataEditor.tagNamesFor", { name: tag.displayName })}
      className="space-y-3 rounded-md border bg-card p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h5 className="truncate text-sm font-semibold">{tag.displayName}</h5>
          <p className="text-xs text-muted-foreground">
            {isNew
              ? t("metadataEditor.tagNamesNew")
              : detail?.status === "ready"
                ? t("metadataEditor.tagNamesShared", { count: detail.tag.workCount })
                : t("metadataEditor.tagNamesSharedUnknown")}
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onDone}>
          {t("metadataEditor.tagNamesDone")}
        </Button>
      </div>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">{rows()}</div>
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

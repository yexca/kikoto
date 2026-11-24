import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  api,
  type LibrarySource,
  type WorkDetail,
  type WorkMetadataPreview,
  type WorkMetadataPreviewValues,
} from "@/lib/api";
import { startLoad } from "@/lib/effectScope";
import { librarySourceProvidesMetadata } from "@/lib/remoteSourceCapabilities";

export type MetadataPreviewSelection = "current" | "fetched" | "manual" | "merged";
export type MetadataPreviewSelections = Record<string, MetadataPreviewSelection>;

const comparableFields = [
  "title",
  "description",
  "releaseDate",
  "ageRating",
  "circle",
  "series",
  "tags",
  "voiceActors",
  "cover",
] as const;
type ComparableField = (typeof comparableFields)[number];

export function MetadataPreviewDialog({
  work,
  sources,
  open,
  readOnly,
  onClose,
  onApply,
}: {
  work: WorkDetail;
  sources: LibrarySource[];
  open: boolean;
  readOnly: boolean;
  onClose: () => void;
  onApply: (
    preview: WorkMetadataPreview,
    expected: WorkMetadataPreviewValues,
    selections: MetadataPreviewSelections,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [preview, setPreview] = useState<WorkMetadataPreview | null>(null);
  const [expected, setExpected] = useState<WorkMetadataPreviewValues | null>(null);
  const [selections, setSelections] = useState<MetadataPreviewSelections>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<number | undefined>(undefined);
  const previewSources = sources.filter((source) => source.enabled && librarySourceProvidesMetadata(source));

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPreview(null);
    setExpected(null);
    setSelections(Object.fromEntries(comparableFields.map((field) => [field, "current"])));
    return startLoad(() => api.previewWorkMetadata(work.id, selectedSourceId), {
      onSuccess: (result) => {
        setPreview(result);
        setExpected(copyValues(result.current));
      },
      onError: (error) => toast.notify(toastFromError(error, t("metadataEditor.previewFailed"))),
      onSettled: () => setLoading(false),
    });
  }, [open, work.id, selectedSourceId, toast, t]);

  if (!open) return null;

  const select = (field: ComparableField, side: "current" | "fetched") => {
    if (!preview || readOnly || saving) return;
    const value = previewFieldValue(preview[side], field);
    const expectedField = field === "cover" ? "coverAvailable" : field;
    setExpected((current) => (current ? { ...current, [expectedField]: copyField(value) } : current));
    setSelections((current) => ({ ...current, [field]: side }));
  };

  const editText = (field: "title" | "description" | "releaseDate" | "ageRating" | "circle", value: string) => {
    if (readOnly || saving) return;
    setExpected((current) =>
      current ? { ...current, [field]: field === "releaseDate" ? value || null : value } : current,
    );
    setSelections((current) => ({ ...current, [field]: "manual" }));
  };

  const save = async () => {
    if (!preview || !expected || readOnly || saving) return;
    setSaving(true);
    try {
      await onApply(preview, expected, selections);
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, t("metadataEditor.previewSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      onClose={saving ? () => {} : onClose}
      size="full"
      layer="overlay-top"
      dismissible={false}
      marker="metadata-preview-editor"
    >
      <DialogHeader
        title={t("metadataEditor.previewTitle")}
        description={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs">{work.primaryCode}</span>
            <span className="truncate">{preview?.sourceName ?? t("metadataEditor.previewLoading")}</span>
          </span>
        }
        onClose={saving ? undefined : onClose}
        closeLabel={t("content.close")}
      />
      <DialogBody className="space-y-4">
        {previewSources.length > 0 && (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t("metadataEditor.previewSource")}</span>
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              aria-label={t("metadataEditor.previewSource")}
              value={selectedSourceId ?? "dlsite"}
              disabled={loading || saving}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedSourceId(value === "dlsite" ? undefined : Number(value));
              }}
            >
              <option value="dlsite">{t("metadataEditor.previewSourceDLsite")}</option>
              {previewSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("metadataEditor.previewLoading")}
          </div>
        )}
        {preview && expected && (
          <>
            <p className="text-sm text-muted-foreground">{t("metadataEditor.previewDescription")}</p>
            <div className="grid gap-3 lg:grid-cols-3">
              <PreviewColumn title={t("metadataEditor.previewCurrent")} values={preview.current} />
              <PreviewColumn title={t("metadataEditor.previewFetched")} values={preview.fetched} fetched />
              <PreviewColumn title={t("metadataEditor.previewExpected")} values={expected} expected />
            </div>
            <div className="space-y-3">
              {preview.provider === "dlsite" && preview.fetched.family.length > 0 && (
                <Button
                  type="button"
                  variant={selections.family === "fetched" ? "default" : "outline"}
                  size="sm"
                  disabled={readOnly || saving}
                  onClick={() => setSelections((current) => ({ ...current, family: "fetched" }))}
                >
                  {t("metadataEditor.previewAcceptFamily")}
                </Button>
              )}
              {comparableFields.map((field) => (
                <PreviewField
                  key={field}
                  field={field}
                  current={previewFieldValue(preview.current, field)}
                  fetched={previewFieldValue(preview.fetched, field)}
                  expected={previewFieldValue(expected, field)}
                  selection={selections[field] ?? "current"}
                  disabled={readOnly || saving}
                  onSelect={select}
                  onEdit={editText}
                  onMerge={(field) => {
                    if (field !== "tags" || !preview || readOnly || saving) return;
                    setExpected((current) =>
                      current
                        ? {
                            ...current,
                            tags: [...new Set([...preview.current.tags, ...preview.fetched.tags])],
                            tagItems: mergeTagItems(preview.current.tagItems ?? [], preview.fetched.tagItems ?? []),
                          }
                        : current,
                    );
                    setSelections((current) => ({ ...current, tags: "merged" }));
                  }}
                />
              ))}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
          {t("content.cancel")}
        </Button>
        <Button size="sm" disabled={readOnly || saving || !preview || !expected} onClick={() => void save()}>
          {saving ? t("common.saving") : t("metadataEditor.previewSave")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function PreviewColumn({
  title,
  values,
  fetched,
  expected,
}: {
  title: string;
  values: WorkMetadataPreviewValues;
  fetched?: boolean;
  expected?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={`rounded-md border p-3 ${fetched ? "border-primary/50 bg-primary/5" : expected ? "border-emerald-500/50 bg-emerald-500/5" : "bg-card"}`}
    >
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <p className="truncate text-sm font-medium">{values.title || "—"}</p>
      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{values.description || "—"}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {t("metadataEditor.previewStats", {
          rating: values.rating ?? "—",
          sales: values.sales ?? "—",
          price: values.price ?? "—",
        })}
      </p>
      <div className="mt-2 flex flex-wrap gap-1">
        {(values.tags ?? []).slice(0, 8).map((tag) => (
          <Badge key={tag} variant="secondary">
            {tag}
          </Badge>
        ))}
        {(values.tags ?? []).length > 8 && <Badge variant="outline">+{(values.tags ?? []).length - 8}</Badge>}
      </div>
      {(values.family ?? []).length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {(values.family ?? []).map((edition) => edition.code).join(" · ")}
        </p>
      )}
    </section>
  );
}

function PreviewField({
  field,
  current,
  fetched,
  expected,
  selection,
  disabled,
  onSelect,
  onEdit,
  onMerge,
}: {
  field: ComparableField;
  current: unknown;
  fetched: unknown;
  expected: unknown;
  selection: MetadataPreviewSelection;
  disabled: boolean;
  onSelect: (field: ComparableField, side: "current" | "fetched") => void;
  onEdit: (field: "title" | "description" | "releaseDate" | "ageRating" | "circle", value: string) => void;
  onMerge: (field: ComparableField) => void;
}) {
  const { t } = useTranslation();
  const label = t(`metadataEditor.previewFields.${field}`);
  const editable = ["title", "description", "releaseDate", "ageRating", "circle"].includes(field);
  return (
    <div className="grid gap-2 rounded-md border p-3 md:grid-cols-[minmax(7rem,0.35fr)_1fr_1fr_1fr] md:items-start">
      <div className="text-sm font-medium">{label}</div>
      <ChoiceCard
        label={t("metadataEditor.previewCurrent")}
        value={formatValue(field, current)}
        active={selection === "current"}
        disabled={disabled}
        onClick={() => onSelect(field, "current")}
      />
      <ChoiceCard
        label={t("metadataEditor.previewFetched")}
        value={formatValue(field, fetched)}
        active={selection === "fetched"}
        disabled={disabled}
        onClick={() => onSelect(field, "fetched")}
      />
      {editable ? (
        <Input
          fieldSize="sm"
          value={typeof expected === "string" ? expected : formatValue(field, expected)}
          disabled={disabled}
          onChange={(event) =>
            onEdit(field as "title" | "description" | "releaseDate" | "ageRating" | "circle", event.target.value)
          }
          aria-label={t("metadataEditor.previewExpectedField", { field: label })}
        />
      ) : (
        <ChoiceCard
          label={t("metadataEditor.previewExpected")}
          value={formatValue(field, expected)}
          active={selection === "manual" || (field === "tags" && selection === "merged")}
          disabled={disabled}
        />
      )}
      {field === "tags" && (
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onMerge(field)}>
          {t("metadataEditor.previewMerge")}
        </Button>
      )}
    </div>
  );
}

function ChoiceCard({
  label,
  value,
  active,
  disabled,
  onClick,
}: {
  label: string;
  value: string;
  active: boolean;
  disabled: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`min-w-0 rounded-md border p-2 text-left text-sm ${active ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {active && <Check className="h-3 w-3" />} {label}
      </span>
      <span className="mt-1 block whitespace-pre-wrap break-words">{value || "—"}</span>
    </button>
  );
}

function formatValue(field: ComparableField, value: unknown): string {
  if (field === "tags" || field === "voiceActors") return Array.isArray(value) ? value.join(", ") : "";
  if (field === "releaseDate") return typeof value === "string" ? value : "";
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function previewFieldValue(values: WorkMetadataPreviewValues, field: ComparableField): unknown {
  return field === "cover" ? values.coverAvailable : values[field];
}

function copyValues(values: WorkMetadataPreviewValues): WorkMetadataPreviewValues {
  return {
    ...values,
    tags: [...(values.tags ?? [])],
    tagItems: (values.tagItems ?? []).map((item) => ({ ...item })),
    voiceActors: [...(values.voiceActors ?? [])],
    family: (values.family ?? []).map((item) => ({ ...item })),
  };
}

function mergeTagItems(current: WorkMetadataPreviewValues["tagItems"], fetched: WorkMetadataPreviewValues["tagItems"]) {
  const seen = new Set<number>();
  return [...current, ...fetched].filter((item) => {
    if (item.id <= 0) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function copyField<T>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T;
}

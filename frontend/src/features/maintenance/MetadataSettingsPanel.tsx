import { ArrowDown, ArrowUp, GripVertical, Save, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api, type AppSettings, type FileSource } from "@/lib/api";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input, NativeSelect } from "@/components/ui/input";
import {
  dlsiteMetadataLanguageOptions,
  moveDlsiteMetadataLanguage,
  moveDlsiteMetadataLanguageTo,
  normalizeDlsiteMetadataLanguages,
  type DlsiteMetadataLanguage,
} from "./metadataLanguageModel";
import { InfoHint } from "./InfoHint";
import i18n from "@/i18n";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);
const remoteRequestLanguageOptions = [
  { value: "ja-JP", labelKey: "metadata.japanese" },
  { value: "en-US", labelKey: "metadata.english" },
  { value: "zh-CN", labelKey: "metadata.simplifiedChinese" },
  { value: "zh-TW", labelKey: "metadata.traditionalChinese" },
  { value: "ko-KR", labelKey: "metadata.korean" },
] as const;
/**
 * Metadata settings shown in the page's settings popover: a compact header,
 * the editable groups with hover explanations, and a sticky save footer.
 */
export function MetadataSettingsPanel({ readOnly = false, onClose }: { readOnly?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [languages, setLanguages] = useState<DlsiteMetadataLanguage[]>([]);
  const [days, setDays] = useState(30);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [updatingSourceId, setUpdatingSourceId] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setError(false);
    api
      .getSettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setLanguages(normalizeDlsiteMetadataLanguages(next.dlsiteMetadataLanguages ?? [next.dlsiteMetadataLanguage]));
        setDays(next.catalogFreshnessDays);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const save = async () => {
    if (readOnly || saving) return;
    setSaving(true);
    try {
      const next = await api.updateSettings({ dlsiteMetadataLanguages: languages, catalogFreshnessDays: days });
      setSettings(next);
      toast.success(maintenanceCopy("settingsSaved"));
    } catch (cause) {
      toast.notify(toastFromError(cause, t("errors.unavailable")));
    } finally {
      setSaving(false);
    }
  };
  const updateLanguage = async (source: FileSource, requestLanguage: string) => {
    if (readOnly || updatingSourceId !== null) return;
    setUpdatingSourceId(source.id);
    try {
      const updated = await api.updateFileSource(source.id, {
        displayName: source.displayName,
        sourceType: source.sourceType,
        priority: source.priority,
        enabled: source.enabled,
        config: { ...source.config, requestLanguage },
        endpoint: source.endpoint,
      });
      setSettings((current) =>
        current
          ? { ...current, fileSources: current.fileSources.map((item) => (item.id === updated.id ? updated : item)) }
          : current,
      );
      toast.success(maintenanceCopy("requestLanguageUpdated", { name: source.displayName }));
    } catch (cause) {
      toast.notify(toastFromError(cause, maintenanceCopy("requestLanguageSaveFailed")));
    } finally {
      setUpdatingSourceId(null);
    }
  };
  const header = (
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
      <h2 className="text-sm font-semibold">{t("workManagement.settings")}</h2>
      <Button
        size="icon-sm"
        variant="ghost"
        className="-mr-2 text-muted-foreground"
        aria-label={t("common.close")}
        title={t("common.close")}
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
  if (error)
    return (
      <>
        {header}
        <div className="p-4">
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
          >
            {t("errors.unavailable")}
            <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        </div>
      </>
    );
  if (!settings)
    return (
      <>
        {header}
        <div role="status" aria-label={t("workManagement.loading")} aria-busy="true" className="space-y-5 p-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="space-y-2">
              <div className="h-3 w-32 animate-pulse rounded bg-muted" />
              <div className="h-9 animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
      </>
    );
  return (
    <>
      {header}
      <MetadataSettings
        disabled={readOnly || saving}
        catalogFreshnessDays={days}
        languages={languages}
        remoteSources={settings.fileSources.filter(
          (source) =>
            source.sourceType === "kikoeru_compatible" || source.sourceType === "kikoeru_compatible_number178",
        )}
        updatingSourceId={updatingSourceId}
        onCatalogFreshnessDaysChange={setDays}
        onLanguagesChange={setLanguages}
        onRequestLanguageChange={updateLanguage}
      />
      <div className="sticky bottom-0 flex justify-end border-t bg-popover px-4 py-2">
        <Button size="sm" onClick={() => void save()} disabled={readOnly || saving}>
          <Save className="h-3.5 w-3.5" />
          {maintenanceCopy("metadata.save")}
        </Button>
      </div>
    </>
  );
}

function SettingsGroup({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        <InfoHint label={title}>{hint}</InfoHint>
      </div>
      {children}
    </section>
  );
}

const orderButtonClassName =
  "grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30 max-sm:h-11 max-sm:w-11";

function MetadataSettings({
  disabled,
  catalogFreshnessDays,
  languages,
  remoteSources,
  updatingSourceId,
  onCatalogFreshnessDaysChange,
  onLanguagesChange,
  onRequestLanguageChange,
}: {
  disabled: boolean;
  catalogFreshnessDays: number;
  languages: DlsiteMetadataLanguage[];
  remoteSources: FileSource[];
  updatingSourceId: number | null;
  onCatalogFreshnessDaysChange: (value: number) => void;
  onLanguagesChange: (value: DlsiteMetadataLanguage[]) => void;
  onRequestLanguageChange: (source: FileSource, language: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draggedLanguage, setDraggedLanguage] = useState<DlsiteMetadataLanguage | null>(null);
  const draggedLanguageRef = useRef<DlsiteMetadataLanguage | null>(null);
  const finishDrag = () => {
    draggedLanguageRef.current = null;
    setDraggedLanguage(null);
  };

  useEffect(() => {
    if (draggedLanguage === null) return;
    const finish = () => {
      draggedLanguageRef.current = null;
      setDraggedLanguage(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [draggedLanguage]);

  const moveLanguage = (index: number, direction: -1 | 1) => {
    onLanguagesChange(moveDlsiteMetadataLanguage(languages, index, direction));
  };

  const setLanguageIncluded = (language: DlsiteMetadataLanguage, included: boolean) => {
    if (language === "origin") return;
    const next = included
      ? [...languages.filter((candidate) => candidate !== "origin"), language, "origin"]
      : languages.filter((candidate) => candidate !== language);
    onLanguagesChange(normalizeDlsiteMetadataLanguages(next));
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 border-0 px-4 py-3">
      <SettingsGroup title={t("metadata.priorityTitle")} hint={t("metadata.priorityDescription")}>
        <fieldset className="min-w-0">
          <legend className="sr-only">{t("metadata.preferredLanguages")}</legend>
          <div className="flex flex-wrap gap-1.5">
            {dlsiteMetadataLanguageOptions
              .filter((option) => option.value !== "origin")
              .map((option) => {
                const included = languages.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className={`inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors max-sm:min-h-11 ${
                      included
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Checkbox
                      checked={included}
                      onCheckedChange={(checked) => setLanguageIncluded(option.value, checked)}
                      aria-label={t("metadata.prefer", { language: t(option.labelKey) })}
                    />
                    <span>{t(option.labelKey)}</span>
                  </label>
                );
              })}
          </div>
        </fieldset>
        <ol
          className="divide-y overflow-hidden rounded-lg border bg-card"
          aria-label={maintenanceCopy("metadata.languagePriority")}
        >
          {languages.map((language, index) => {
            const option = dlsiteMetadataLanguageOptions.find((candidate) => candidate.value === language);
            if (!option) return null;
            const label = t(option.labelKey);
            const locked = language === "origin";
            return (
              <li
                key={language}
                data-metadata-language-index={index}
                className={`flex min-h-10 items-center gap-1.5 px-1.5 py-1 transition-opacity ${
                  draggedLanguage === language ? "bg-muted/60 opacity-60" : ""
                }`}
              >
                <button
                  type="button"
                  className="grid h-7 w-7 shrink-0 touch-none cursor-grab place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent max-sm:h-11 max-sm:w-11"
                  aria-label={t("metadata.drag", { language: label })}
                  disabled={locked}
                  onPointerDown={(event) => {
                    if (!event.isPrimary || event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    draggedLanguageRef.current = language;
                    setDraggedLanguage(language);
                  }}
                  onPointerMove={(event) => {
                    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                    const sourceLanguage = draggedLanguageRef.current;
                    const source = sourceLanguage ? languages.indexOf(sourceLanguage) : -1;
                    const target = Number(
                      document
                        .elementFromPoint(event.clientX, event.clientY)
                        ?.closest<HTMLElement>("[data-metadata-language-index]")?.dataset.metadataLanguageIndex,
                    );
                    if (source >= 0 && Number.isInteger(target) && source !== target) {
                      onLanguagesChange(moveDlsiteMetadataLanguageTo(languages, source, target));
                    }
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    }
                    finishDrag();
                  }}
                  onPointerCancel={finishDrag}
                  onLostPointerCapture={finishDrag}
                >
                  <GripVertical className="h-4 w-4" />
                </button>
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums ${
                    index === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
                <span className="flex shrink-0">
                  <button
                    type="button"
                    className={orderButtonClassName}
                    aria-label={t("metadata.moveEarlier", { language: label })}
                    title={t("metadata.moveEarlier", { language: label })}
                    disabled={index === 0 || locked}
                    onClick={() => moveLanguage(index, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={orderButtonClassName}
                    aria-label={t("metadata.moveLater", { language: label })}
                    title={t("metadata.moveLater", { language: label })}
                    disabled={index === languages.length - 1 || locked}
                    onClick={() => moveLanguage(index, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </SettingsGroup>

      {remoteSources.length > 0 && (
        <SettingsGroup
          title={maintenanceCopy("metadata.remoteRequests")}
          hint={maintenanceCopy("metadata.remoteRequestsDescription")}
        >
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            {remoteSources.map((source) => {
              const requestLanguage = source.config.requestLanguage ?? "ja-JP";
              const known = remoteRequestLanguageOptions.some(
                (option) => option.value.toLowerCase() === requestLanguage.toLowerCase(),
              );
              const value =
                remoteRequestLanguageOptions.find(
                  (option) => option.value.toLowerCase() === requestLanguage.toLowerCase(),
                )?.value ?? requestLanguage;
              return (
                <label key={source.id} className="flex min-h-10 items-center justify-between gap-3 px-2.5 py-1 text-sm">
                  <span className="min-w-0 truncate font-medium">{source.displayName}</span>
                  <NativeSelect
                    fieldSize="sm"
                    className="w-36 shrink-0"
                    value={value}
                    disabled={updatingSourceId !== null}
                    aria-label={`${source.displayName} metadata request language`}
                    onChange={(event) => void onRequestLanguageChange(source, event.target.value)}
                  >
                    {!known && <option value={requestLanguage}>Custom ({requestLanguage})</option>}
                    {remoteRequestLanguageOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {t(option.labelKey)}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              );
            })}
          </div>
        </SettingsGroup>
      )}

      <section className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          <label htmlFor="metadata-catalog-freshness" className="truncate text-xs font-semibold text-muted-foreground">
            {maintenanceCopy("metadata.catalogFreshnessDays")}
          </label>
          <InfoHint label={maintenanceCopy("metadata.catalogFreshnessDays")}>
            {maintenanceCopy("metadata.catalogFreshnessDescription", { count: catalogFreshnessDays })}
          </InfoHint>
        </div>
        <Input
          id="metadata-catalog-freshness"
          type="number"
          min={1}
          max={365}
          fieldSize="sm"
          className="w-20 text-right tabular-nums"
          value={catalogFreshnessDays}
          onChange={(event) => onCatalogFreshnessDaysChange(Number(event.target.value))}
        />
      </section>
    </fieldset>
  );
}

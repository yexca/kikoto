import { ArrowLeft, ArrowRight, GripVertical, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import i18n from "@/i18n";
const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);
const remoteRequestLanguageOptions = [
  { value: "ja-JP", labelKey: "metadata.japanese" },
  { value: "en-US", labelKey: "metadata.english" },
  { value: "zh-CN", labelKey: "metadata.simplifiedChinese" },
  { value: "zh-TW", labelKey: "metadata.traditionalChinese" },
  { value: "ko-KR", labelKey: "metadata.korean" },
] as const;
export function MetadataSettingsPanel({ readOnly = false }: { readOnly?: boolean }) {
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
  if (error)
    return (
      <div role="alert" className="rounded-lg border p-4">
        {t("errors.unavailable")}{" "}
        <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!settings)
    return (
      <div role="status" className="rounded-lg border p-4 text-muted-foreground">
        {t("workManagement.loading")}
      </div>
    );
  return (
    <fieldset disabled={readOnly || saving} className="min-w-0 border-0 p-0">
      <MetadataSettings
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
        onSave={save}
      />
    </fieldset>
  );
}
function MetadataSettings({
  catalogFreshnessDays,
  languages,
  remoteSources,
  updatingSourceId,
  onCatalogFreshnessDaysChange,
  onLanguagesChange,
  onRequestLanguageChange,
  onSave,
}: {
  catalogFreshnessDays: number;
  languages: DlsiteMetadataLanguage[];
  remoteSources: FileSource[];
  updatingSourceId: number | null;
  onCatalogFreshnessDaysChange: (value: number) => void;
  onLanguagesChange: (value: DlsiteMetadataLanguage[]) => void;
  onRequestLanguageChange: (source: FileSource, language: string) => Promise<void>;
  onSave: () => Promise<void>;
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
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <RefreshCw className="h-4 w-4" />
          </span>
          {t("metadata.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div>
            <div className="font-medium">{t("metadata.priorityTitle")}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t("metadata.priorityDescription")}</p>
          </div>
          <fieldset className="grid gap-2 rounded-md border bg-background p-3">
            <legend className="px-1 text-xs font-semibold text-muted-foreground">
              {t("metadata.preferredLanguages")}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {dlsiteMetadataLanguageOptions
                .filter((option) => option.value !== "origin")
                .map((option) => (
                  <label key={option.value} className="inline-flex min-h-8 items-center gap-2 text-sm">
                    <Checkbox
                      checked={languages.includes(option.value)}
                      onCheckedChange={(checked) => setLanguageIncluded(option.value, checked)}
                      aria-label={t("metadata.prefer", { language: t(option.labelKey) })}
                    />
                    <span>{t(option.labelKey)}</span>
                  </label>
                ))}
            </div>
          </fieldset>
          <div
            className="app-scrollbar flex gap-2 overflow-x-auto pb-1"
            role="list"
            aria-label={maintenanceCopy("metadata.languagePriority")}
          >
            {languages.map((language, index) => {
              const option = dlsiteMetadataLanguageOptions.find((candidate) => candidate.value === language);
              if (!option) return null;
              return (
                <div
                  key={language}
                  data-metadata-language-index={index}
                  role="listitem"
                  className={`flex min-w-[12rem] shrink-0 flex-col justify-between gap-3 rounded-md border bg-background p-3 ${
                    draggedLanguage === language ? "opacity-55" : ""
                  }`}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <button
                      type="button"
                      className="grid h-8 w-8 shrink-0 touch-none cursor-grab place-items-center rounded-md border bg-card text-muted-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
                      aria-label={t("metadata.drag", { language: t(option.labelKey) })}
                      disabled={language === "origin"}
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
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{t(option.labelKey)}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {index === 0
                          ? maintenanceCopy("metadata.firstChoice")
                          : maintenanceCopy("metadata.fallbackChoice", { count: index + 1 })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 border-t pt-2">
                    <span className="text-2xs font-semibold uppercase text-muted-foreground">
                      {maintenanceCopy("metadata.priority", { count: index + 1 })}
                    </span>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className="grid h-7 w-7 place-items-center rounded-md border text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                        aria-label={t("metadata.moveEarlier", { language: t(option.labelKey) })}
                        title={t("metadata.moveEarlier", { language: t(option.labelKey) })}
                        disabled={index === 0 || language === "origin"}
                        onClick={() => moveLanguage(index, -1)}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="grid h-7 w-7 place-items-center rounded-md border text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                        aria-label={t("metadata.moveLater", { language: t(option.labelKey) })}
                        title={t("metadata.moveLater", { language: t(option.labelKey) })}
                        disabled={index === languages.length - 1 || language === "origin"}
                        onClick={() => moveLanguage(index, 1)}
                      >
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <div>
            <div className="font-medium">{maintenanceCopy("metadata.remoteRequests")}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {maintenanceCopy("metadata.remoteRequestsDescription")}
            </p>
          </div>
          {remoteSources.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
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
                  <label key={source.id} className="grid gap-1 rounded-md border bg-background p-3 text-sm">
                    <span className="truncate font-medium">{source.displayName}</span>
                    <NativeSelect
                      fieldSize="sm"
                      className="min-w-0"
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
          ) : (
            <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
              {maintenanceCopy("metadata.noRemoteSources")}
            </div>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{maintenanceCopy("metadata.catalogFreshnessDays")}</span>
            <Input
              fieldSize="sm"
              type="number"
              min={1}
              max={365}
              value={catalogFreshnessDays}
              onChange={(event) => onCatalogFreshnessDaysChange(Number(event.target.value))}
            />
          </label>
          <div className="self-end rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            {maintenanceCopy("metadata.catalogFreshnessDescription", { count: catalogFreshnessDays })}
          </div>
        </div>
        <Button size="sm" onClick={() => void onSave()}>
          <Save className="h-4 w-4" />
          {maintenanceCopy("metadata.save")}
        </Button>
      </CardContent>
    </Card>
  );
}

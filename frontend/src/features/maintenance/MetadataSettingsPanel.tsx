import { ArrowDown, ArrowUp, Save, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { api, type AppSettings, type FileSource, type RemoteMetadataFallbackSettings } from "@/lib/api";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Input, NativeSelect } from "@/components/ui/input";
import { DLsiteProxyQuickSwitch } from "@/features/proxy";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { InfoHint } from "./InfoHint";
import {
  defaultRemoteMetadataFallback,
  moveRemoteMetadataSource,
  normalizedRemoteMetadataFallback,
  remoteMetadataFallbackRows,
  sameRemoteMetadataFallback,
  toggleRemoteMetadataSource,
} from "./remoteMetadataFallbackModel";
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
  const [days, setDays] = useState(30);
  const [fallback, setFallback] = useState<RemoteMetadataFallbackSettings>(defaultRemoteMetadataFallback);
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
        setDays(next.catalogFreshnessDays);
        setFallback(next.remoteMetadataFallback ?? defaultRemoteMetadataFallback);
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
      const sources = settings?.fileSources ?? [];
      const nextFallback = normalizedRemoteMetadataFallback(sources, fallback);
      const savedFallback = normalizedRemoteMetadataFallback(
        sources,
        settings?.remoteMetadataFallback ?? defaultRemoteMetadataFallback,
      );
      // Send only changed groups so this form never overwrites other settings.
      const next = await api.updateSettings({
        catalogFreshnessDays: days,
        ...(sameRemoteMetadataFallback(nextFallback, savedFallback) ? {} : { remoteMetadataFallback: nextFallback }),
      });
      setSettings(next);
      setFallback(next.remoteMetadataFallback ?? defaultRemoteMetadataFallback);
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
  const manageProxies = () => {
    onClose();
    window.history.pushState({}, "", "/settings?tab=proxy");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
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
        proxy={
          <DLsiteProxyQuickSwitch
            proxy={settings.proxy}
            readOnly={readOnly}
            onSaved={setSettings}
            onManage={manageProxies}
          />
        }
        remoteSources={settings.fileSources.filter(
          (source) =>
            source.sourceType === "kikoeru_compatible" || source.sourceType === "kikoeru_compatible_number178",
        )}
        updatingSourceId={updatingSourceId}
        onCatalogFreshnessDaysChange={setDays}
        onRequestLanguageChange={updateLanguage}
        fallback={
          <RemoteMetadataFallbackGroup sources={settings.fileSources} value={fallback} onChange={setFallback} />
        }
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

/**
 * Opt-in remote metadata fallback: the switch and the ordered metadata-capable
 * sources. Saved with the rest of the form.
 */
function RemoteMetadataFallbackGroup({
  sources,
  value,
  onChange,
}: {
  sources: FileSource[];
  value: RemoteMetadataFallbackSettings;
  onChange: (value: RemoteMetadataFallbackSettings) => void;
}) {
  const rows = remoteMetadataFallbackRows(sources, value);
  const selectedCount = rows.filter((row) => row.selected).length;
  const lastSelected = selectedCount - 1;
  return (
    <SettingsGroup
      title={maintenanceCopy("metadata.remoteFallback")}
      hint={maintenanceCopy("metadata.remoteFallbackDescription")}
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        <span id="remote-metadata-fallback-label" className="min-w-0">
          {maintenanceCopy("metadata.remoteFallbackEnabled")}
        </span>
        <Switch
          checked={value.enabled}
          aria-labelledby="remote-metadata-fallback-label"
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{maintenanceCopy("metadata.remoteFallbackNoSources")}</p>
      ) : (
        <ol
          aria-label={maintenanceCopy("metadata.remoteFallbackOrder")}
          className="divide-y overflow-hidden rounded-lg border bg-card"
        >
          {rows.map((row) => {
            const name = row.source.displayName;
            return (
              <li key={row.source.id} className="flex min-h-10 items-center gap-2 px-2.5 py-1 text-sm">
                <Checkbox
                  checked={row.selected}
                  aria-label={maintenanceCopy("metadata.remoteFallbackUse", { name })}
                  onCheckedChange={(selected) => onChange(toggleRemoteMetadataSource(value, row.source.id, selected))}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                {row.selected && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={maintenanceCopy("metadata.remoteFallbackEarlier", { name })}
                      title={maintenanceCopy("metadata.remoteFallbackEarlier", { name })}
                      disabled={row.position === 0}
                      onClick={() => onChange(moveRemoteMetadataSource(value, row.source.id, -1))}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={maintenanceCopy("metadata.remoteFallbackLater", { name })}
                      title={maintenanceCopy("metadata.remoteFallbackLater", { name })}
                      disabled={row.position === lastSelected}
                      onClick={() => onChange(moveRemoteMetadataSource(value, row.source.id, 1))}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </SettingsGroup>
  );
}

function MetadataSettings({
  disabled,
  catalogFreshnessDays,
  proxy,
  fallback,
  remoteSources,
  updatingSourceId,
  onCatalogFreshnessDaysChange,
  onRequestLanguageChange,
}: {
  disabled: boolean;
  catalogFreshnessDays: number;
  /** DLsite proxy shortcut; it saves on its own, outside this form. */
  proxy: ReactNode;
  /** Remote metadata fallback controls, saved with this form. */
  fallback: ReactNode;
  remoteSources: FileSource[];
  updatingSourceId: number | null;
  onCatalogFreshnessDaysChange: (value: number) => void;
  onRequestLanguageChange: (source: FileSource, language: string) => Promise<void>;
}) {
  const { t } = useTranslation();

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 border-0 px-4 py-3">
      <SettingsGroup title={maintenanceCopy("metadata.proxy")} hint={maintenanceCopy("metadata.proxyDescription")}>
        {proxy}
      </SettingsGroup>

      {fallback}

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

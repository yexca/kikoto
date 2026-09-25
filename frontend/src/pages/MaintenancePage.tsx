import {
  ArrowRight,
  Eraser,
  FolderOpen,
  Gauge,
  HardDriveDownload,
  Loader2,
  LockKeyhole,
  Save,
  Timer,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  SettingsDisclosure,
  SettingsNumberInput,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { LibraryLayoutSection } from "@/features/library-setup/LibraryLayoutSection";
import { RemoteSourceDialog } from "@/features/sources/RemoteSourceDialog";
import { RemoteSourceList } from "@/features/sources/RemoteSourceList";
import {
  DATA_PREFIX,
  DEFAULT_CACHE_SUFFIX,
  DEFAULT_SAVE_SUFFIX,
  emptyRemoteSource,
  REMOTE_SOURCE_TYPES,
  sourcePayload,
  storagePathPreview,
} from "@/features/sources/remoteSourceModel";
import { api, type AppSettings, type FileSource } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { UsersPage } from "@/pages/UsersPage";

type MaintenanceTab = "library" | "cache" | "users";

type RuntimeDraft = {
  localScanDepth: number;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  transcodeCacheLimitGb: number;
  remoteDownloadLimitGb: number;
  fetchStagingRetentionDays: number;
  remoteDelayBaseSeconds: number;
  remoteDelayRandomSeconds: number;
  remoteBackoffSeconds: number;
  remoteMaxBackoffSeconds: number;
};

function runtimeDraftFromSettings(settings: AppSettings): RuntimeDraft {
  return {
    localScanDepth: settings.localScanDepth,
    cacheEnabled: settings.cacheEnabled,
    cacheLimitGb: settings.cacheLimitGb,
    transcodeCacheLimitGb: settings.transcodeCacheLimitGb ?? 5,
    remoteDownloadLimitGb: settings.remoteDownloadLimitGb,
    fetchStagingRetentionDays: settings.fetchStagingRetentionDays,
    remoteDelayBaseSeconds: settings.remoteDelayBaseSeconds,
    remoteDelayRandomSeconds: settings.remoteDelayRandomSeconds,
    remoteBackoffSeconds: settings.remoteBackoffSeconds,
    remoteMaxBackoffSeconds: settings.remoteMaxBackoffSeconds,
  };
}

export function MaintenancePage({
  canManageSources,
  canManageUsers,
  canManageCleanup,
  currentUserId,
  isSuperAdmin,
  canManageAccessPolicy,
  readOnly = false,
  activeTab,
  onAccessPolicyUpdated,
}: {
  canManageSources: boolean;
  canManageUsers: boolean;
  canManageCleanup: boolean;
  currentUserId: number;
  isSuperAdmin: boolean;
  canManageAccessPolicy: boolean;
  readOnly?: boolean;
  activeTab: MaintenanceTab;
  onAccessPolicyUpdated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [draft, setDraft] = useState<RuntimeDraft | null>(null);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [anonymousAccessEnabled, setAnonymousAccessEnabled] = useState(false);
  const [isAccessPolicySaving, setIsAccessPolicySaving] = useState(false);
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [checkingSourceId, setCheckingSourceId] = useState<number | null>(null);
  const [togglingSourceId, setTogglingSourceId] = useState<number | null>(null);
  const [sourcePendingDelete, setSourcePendingDelete] = useState<FileSource | null>(null);
  const [deletingSourceId, setDeletingSourceId] = useState<number | null>(null);
  const openedLinkedSource = useRef(false);

  const remoteSources = useMemo(
    () => settings?.fileSources.filter((source) => REMOTE_SOURCE_TYPES.has(source.sourceType)) ?? [],
    [settings],
  );
  const localSource = settings?.fileSources.find((source) => source.sourceType === "local_folder") ?? null;
  const savedDraft = settings ? runtimeDraftFromSettings(settings) : null;

  const applySettings = (next: AppSettings) => {
    setSettings(next);
    setDraft(runtimeDraftFromSettings(next));
    setAnonymousAccessEnabled(next.anonymousAccessEnabled);
  };

  const reload = () =>
    api
      .getSettings()
      .then(applySettings)
      .catch((error) => toast.notify(toastFromError(error, t("maintenance.settingsApiUnavailable"))))
      .finally(() => setIsSettingsLoading(false));

  useEffect(() => {
    if (!canManageSources && !canManageAccessPolicy) {
      setIsSettingsLoading(false);
      return;
    }
    void reload();
  }, [canManageSources, canManageAccessPolicy]);

  useEffect(() => {
    if (openedLinkedSource.current || !settings) return;
    const sourceID = Number(new URLSearchParams(window.location.search).get("source"));
    if (!Number.isInteger(sourceID) || sourceID <= 0) return;
    const source = settings.fileSources.find(
      (candidate) => candidate.id === sourceID && REMOTE_SOURCE_TYPES.has(candidate.sourceType),
    );
    if (!source) return;
    openedLinkedSource.current = true;
    setDraftSource(source);
    setEditingSourceId(source.id);
    setIsSourceModalOpen(true);
  }, [settings]);

  useEffect(() => {
    if (activeTab !== "library" || window.location.hash !== "#remote-sources") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("remote-sources")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, isSettingsLoading, settings]);

  const patchDraft = (next: Partial<RuntimeDraft>) =>
    setDraft((current) => (current ? { ...current, ...next } : current));

  const saveRuntimeSettings = async () => {
    if (readOnly || !draft) return;
    setSavingRuntime(true);
    try {
      applySettings(await api.updateSettings(draft));
      toast.success(t("maintenance.settingsSaved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.settingsApiUnavailable")));
    } finally {
      setSavingRuntime(false);
    }
  };

  const saveAccessPolicy = async () => {
    if (readOnly || !canManageAccessPolicy) return;
    setIsAccessPolicySaving(true);
    try {
      const next = await api.updateAccessPolicy({ anonymousAccessEnabled });
      setSettings((current) => (current ? { ...current, ...next } : current));
      setAnonymousAccessEnabled(next.anonymousAccessEnabled);
      try {
        await onAccessPolicyUpdated();
      } catch {
        toast.warning(t("maintenance.accessPolicyRefreshFailed"));
        return;
      }
      toast.success(t("maintenance.accessPolicySaved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.accessPolicySaveFailed")));
    } finally {
      setIsAccessPolicySaving(false);
    }
  };

  const openCreateSource = () => {
    if (readOnly) return;
    setDraftSource(emptyRemoteSource);
    setEditingSourceId(null);
    setIsSourceModalOpen(true);
  };

  const openEditSource = (source: FileSource) => {
    setDraftSource(source);
    setEditingSourceId(source.id);
    setIsSourceModalOpen(true);
  };

  const closeSourceModal = () => {
    setIsSourceModalOpen(false);
    setDraftSource(emptyRemoteSource);
    setEditingSourceId(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("source")) {
      url.searchParams.delete("source");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  };

  const saveSource = async () => {
    if (readOnly) return;
    setSavingSource(true);
    try {
      if (editingSourceId) await api.updateFileSource(editingSourceId, sourcePayload(draftSource));
      else await api.createFileSource(sourcePayload(draftSource));
      closeSourceModal();
      await reload();
      toast.success(t("maintenance.sourceSaved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("sourceSetup.saveFailed")));
    } finally {
      setSavingSource(false);
    }
  };

  const replaceSource = (next: FileSource) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            fileSources: current.fileSources.map((source) => (source.id === next.id ? next : source)),
          }
        : current,
    );

  const toggleSourceEnabled = async (source: FileSource, enabled: boolean) => {
    if (readOnly) return;
    setTogglingSourceId(source.id);
    replaceSource({ ...source, enabled });
    try {
      replaceSource(await api.updateFileSource(source.id, { ...sourcePayload(source), enabled }));
      toast.success(
        t(enabled ? "sourceSetup.enabledToast" : "sourceSetup.disabledToast", { name: source.displayName }),
      );
    } catch (error) {
      replaceSource(source);
      toast.notify(toastFromError(error, t("sourceSetup.saveFailed")));
    } finally {
      setTogglingSourceId(null);
    }
  };

  const deleteSource = async () => {
    if (readOnly || !sourcePendingDelete) return;
    const source = sourcePendingDelete;
    setDeletingSourceId(source.id);
    try {
      await api.deleteFileSource(source.id);
      setSettings((current) =>
        current
          ? { ...current, fileSources: current.fileSources.filter((candidate) => candidate.id !== source.id) }
          : current,
      );
      setSourcePendingDelete(null);
      toast.success(t("maintenance.sourceDeleted"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.sourceDeleteFailed")));
    } finally {
      setDeletingSourceId(null);
    }
  };

  const checkSourceHealth = async (id: number) => {
    if (readOnly) return;
    setCheckingSourceId(id);
    try {
      const result = await api.checkFileSourceHealth(id);
      setSettings((current) =>
        current
          ? {
              ...current,
              fileSources: current.fileSources.map((source) =>
                source.id === id
                  ? { ...source, healthStatus: result.healthStatus, lastCheckedAt: result.lastCheckedAt }
                  : source,
              ),
            }
          : current,
      );
      if (result.healthy) toast.success(t("maintenance.sourceHealthPassed"));
      else toast.warning(t("maintenance.sourceHealthFailed"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.sourceHealthCheckFailed")));
    } finally {
      setCheckingSourceId(null);
    }
  };

  if (!canManageSources && !canManageUsers && !canManageAccessPolicy) {
    return (
      <section className="rounded-lg border bg-card p-5">
        <p className="text-sm text-muted-foreground">{t("maintenance.adminRequired")}</p>
      </section>
    );
  }

  const runtimeDirty = (keys: Array<keyof RuntimeDraft>) =>
    Boolean(draft && savedDraft && keys.some((key) => draft[key] !== savedDraft[key]));
  const saveButton = (keys: Array<keyof RuntimeDraft>, label: string) => (
    <Button
      size="sm"
      disabled={readOnly || savingRuntime || !runtimeDirty(keys)}
      onClick={() => void saveRuntimeSettings()}
    >
      {savingRuntime ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {label}
    </Button>
  );

  return (
    <div className="min-w-0 space-y-5">
      {/* Each tab gates its own writes, so Demo can still browse, open details, and follow links. */}
      <fieldset data-testid="maintenance-content" className="w-full min-w-0 border-0 p-0">
        {isSettingsLoading && activeTab !== "users" ? (
          <SettingsSkeleton />
        ) : activeTab === "library" && draft ? (
          <div className="space-y-6">
            <LibraryLayoutSection readOnly={readOnly} />
            <SettingsSection
              title={t("maintenance.library.local")}
              description={localSource?.displayName ?? t("maintenance.mainLocalLibrary")}
              icon={<FolderOpen />}
              footer={saveButton(["localScanDepth"], t("maintenance.library.save"))}
            >
              <SettingsRow
                title={t("maintenance.library.scanDepth")}
                description={
                  (settings?.localScanDepthMinimum ?? 1) > 1
                    ? `${t("sourceSetup.scanDepthDescription")} ${t("librarySetup.scanDepthMinimum", { count: settings?.localScanDepthMinimum ?? 1 })}`
                    : t("sourceSetup.scanDepthDescription")
                }
              >
                <SettingsNumberInput
                  disabled={readOnly}
                  label={t("maintenance.library.scanDepth")}
                  value={draft.localScanDepth}
                  min={settings?.localScanDepthMinimum ?? 1}
                  max={8}
                  unit={t("sourceSetup.levels")}
                  onChange={(localScanDepth) => patchDraft({ localScanDepth })}
                />
              </SettingsRow>
            </SettingsSection>

            <RemoteSourceList
              sources={remoteSources}
              checkingSourceId={checkingSourceId}
              togglingSourceId={togglingSourceId}
              readOnly={readOnly}
              onCreate={openCreateSource}
              onEdit={openEditSource}
              onDelete={setSourcePendingDelete}
              onCheck={checkSourceHealth}
              onToggleEnabled={toggleSourceEnabled}
            />

            <StoragePaths settings={settings} remoteSources={remoteSources} />
          </div>
        ) : activeTab === "cache" && draft ? (
          <CacheFetchSettings
            draft={draft}
            readOnly={readOnly}
            canManageCleanup={canManageCleanup}
            onChange={patchDraft}
            saveButton={saveButton(
              [
                "cacheEnabled",
                "cacheLimitGb",
                "transcodeCacheLimitGb",
                "remoteDownloadLimitGb",
                "fetchStagingRetentionDays",
                "remoteDelayBaseSeconds",
                "remoteDelayRandomSeconds",
                "remoteBackoffSeconds",
                "remoteMaxBackoffSeconds",
              ],
              t("maintenance.cache.save"),
            )}
          />
        ) : activeTab === "users" ? (
          <div className="space-y-6">
            {canManageUsers && (
              <UsersPage currentUserId={currentUserId} isSuperAdmin={isSuperAdmin} readOnly={readOnly} embedded />
            )}
            {canManageAccessPolicy &&
              (isSettingsLoading ? (
                <SettingsSkeleton />
              ) : (
                <SettingsSection
                  title={t("maintenance.access.instance")}
                  icon={<LockKeyhole />}
                  footer={
                    <Button
                      size="sm"
                      disabled={
                        isAccessPolicySaving || anonymousAccessEnabled === (settings?.anonymousAccessEnabled ?? false)
                      }
                      onClick={() => void saveAccessPolicy()}
                    >
                      {isAccessPolicySaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {t("maintenance.access.save")}
                    </Button>
                  }
                >
                  <SettingsRow
                    title={t("maintenance.access.anonymous")}
                    description={t("maintenance.access.anonymousDescription")}
                  >
                    <Switch
                      checked={anonymousAccessEnabled}
                      onCheckedChange={setAnonymousAccessEnabled}
                      aria-label={t("maintenance.access.anonymous")}
                    />
                  </SettingsRow>
                </SettingsSection>
              ))}
          </div>
        ) : null}
      </fieldset>

      {isSourceModalOpen && (
        <RemoteSourceDialog
          source={draftSource}
          defaultSaveTemplate={settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`}
          editing={editingSourceId !== null}
          saving={savingSource}
          readOnly={readOnly}
          onChange={setDraftSource}
          onSave={saveSource}
          onClose={closeSourceModal}
        />
      )}
      {sourcePendingDelete && (
        <Dialog onClose={() => setSourcePendingDelete(null)} size="md" dismissible={deletingSourceId === null}>
          <DialogHeader title={t("maintenance.library.deleteRemoteSource")} />
          <DialogBody>
            <div className="rounded-lg border bg-muted/25 px-3 py-3">
              <div className="truncate text-sm font-semibold" title={sourcePendingDelete.displayName}>
                {sourcePendingDelete.displayName}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t("maintenance.library.deleteSourceDescription")}</p>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={deletingSourceId !== null}
              onClick={() => setSourcePendingDelete(null)}
            >
              {t("maintenance.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingSourceId !== null}
              onClick={() => void deleteSource()}
            >
              {deletingSourceId !== null ? t("maintenance.library.deleting") : t("maintenance.library.deleteSource")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function CacheFetchSettings({
  draft,
  readOnly,
  canManageCleanup,
  onChange,
  saveButton,
}: {
  draft: RuntimeDraft;
  readOnly: boolean;
  canManageCleanup: boolean;
  onChange: (next: Partial<RuntimeDraft>) => void;
  saveButton: ReactNode;
}) {
  const { t } = useTranslation();
  const [confirmEnableCache, setConfirmEnableCache] = useState(false);
  const openCleanup = () => {
    window.history.pushState({}, "", "/settings?tab=cleanup");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  return (
    <div className="space-y-6" data-testid="cache-configuration-card">
      <SettingsSection title={t("maintenance.cache.policy")} icon={<HardDriveDownload />}>
        <SettingsRow
          title={t("maintenance.cache.remotePlayback")}
          description={t("maintenance.cache.remotePlaybackDescription")}
        >
          <Switch
            checked={draft.cacheEnabled}
            disabled={readOnly}
            onCheckedChange={(enabled) => {
              if (enabled && !draft.cacheEnabled) setConfirmEnableCache(true);
              else onChange({ cacheEnabled: enabled });
            }}
            aria-label={t("maintenance.cache.remotePlayback")}
          />
        </SettingsRow>
        <SettingsRow title={t("maintenance.cache.limit")} description={t("maintenance.cache.limitDescription")}>
          <SettingsNumberInput
            disabled={readOnly}
            label={t("maintenance.cache.limit")}
            value={draft.cacheLimitGb}
            min={0}
            unit="GB"
            onChange={(cacheLimitGb) => onChange({ cacheLimitGb })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("maintenance.cache.transcodeLimit")}
          description={t("maintenance.cache.transcodeLimitDescription")}
        >
          <SettingsNumberInput
            disabled={readOnly}
            label={t("maintenance.cache.transcodeLimit")}
            value={draft.transcodeCacheLimitGb}
            min={1}
            max={4096}
            unit="GB"
            onChange={(transcodeCacheLimitGb) => onChange({ transcodeCacheLimitGb })}
          />
        </SettingsRow>
        {canManageCleanup && (
          <SettingsRow title={t("sourceSetup.cleanupLinkTitle")} description={t("sourceSetup.cleanupLinkDescription")}>
            <Button variant="outline" size="sm" onClick={openCleanup}>
              <Eraser className="h-4 w-4" />
              {t("cleanup.tab")}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title={t("maintenance.cache.transferSafety")} icon={<Gauge />}>
        <SettingsRow
          title={t("maintenance.cache.downloadLimit")}
          description={t("maintenance.cache.downloadLimitDescription")}
        >
          <SettingsNumberInput
            disabled={readOnly}
            label={t("maintenance.cache.downloadLimit")}
            value={draft.remoteDownloadLimitGb}
            min={1}
            max={2048}
            unit="GB"
            onChange={(remoteDownloadLimitGb) => onChange({ remoteDownloadLimitGb })}
          />
        </SettingsRow>
        <SettingsRow
          title={t("maintenance.cache.stagingRetention")}
          description={t("maintenance.cache.stagingRetentionDescription")}
        >
          <SettingsNumberInput
            disabled={readOnly}
            label={t("maintenance.cache.stagingRetention")}
            value={draft.fetchStagingRetentionDays}
            min={1}
            max={365}
            unit={t("sourceSetup.days")}
            onChange={(fetchStagingRetentionDays) => onChange({ fetchStagingRetentionDays })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("maintenance.cache.downloadPacing")} icon={<Timer />}>
        <SettingsDisclosure
          title={t("sourceSetup.pacingSummary", {
            base: draft.remoteDelayBaseSeconds,
            random: draft.remoteDelayRandomSeconds,
          })}
          description={t("sourceSetup.pacingDescription")}
        >
          <SettingsRow
            title={t("maintenance.cache.baseDelay")}
            description={t("maintenance.cache.baseDelayDescription")}
          >
            <SettingsNumberInput
              disabled={readOnly}
              label={t("maintenance.cache.baseDelay")}
              value={draft.remoteDelayBaseSeconds}
              min={0}
              step={0.1}
              unit={t("sourceSetup.seconds")}
              onChange={(remoteDelayBaseSeconds) => onChange({ remoteDelayBaseSeconds })}
            />
          </SettingsRow>
          <SettingsRow
            title={t("maintenance.cache.randomDelay")}
            description={t("maintenance.cache.randomDelayDescription")}
          >
            <SettingsNumberInput
              disabled={readOnly}
              label={t("maintenance.cache.randomDelay")}
              value={draft.remoteDelayRandomSeconds}
              min={0}
              step={0.1}
              unit={t("sourceSetup.seconds")}
              onChange={(remoteDelayRandomSeconds) => onChange({ remoteDelayRandomSeconds })}
            />
          </SettingsRow>
          <SettingsRow
            title={t("maintenance.cache.initialBackoff")}
            description={t("maintenance.cache.initialBackoffDescription")}
          >
            <SettingsNumberInput
              disabled={readOnly}
              label={t("maintenance.cache.initialBackoff")}
              value={draft.remoteBackoffSeconds}
              min={0}
              unit={t("sourceSetup.seconds")}
              onChange={(remoteBackoffSeconds) => onChange({ remoteBackoffSeconds })}
            />
          </SettingsRow>
          <SettingsRow
            title={t("maintenance.cache.maximumBackoff")}
            description={t("maintenance.cache.maximumBackoffDescription")}
          >
            <SettingsNumberInput
              disabled={readOnly}
              label={t("maintenance.cache.maximumBackoff")}
              value={draft.remoteMaxBackoffSeconds}
              min={0}
              unit={t("sourceSetup.seconds")}
              onChange={(remoteMaxBackoffSeconds) => onChange({ remoteMaxBackoffSeconds })}
            />
          </SettingsRow>
        </SettingsDisclosure>
      </SettingsSection>

      <div className="flex justify-end">{saveButton}</div>

      {confirmEnableCache && (
        <Dialog onClose={() => setConfirmEnableCache(false)} layer="sheet" size="lg" role="alertdialog">
          <DialogHeader
            title={t("maintenance.cache.enableTitle")}
            description={t("maintenance.cache.enableDescription")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEnableCache(false)}>
              {t("maintenance.cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirmEnableCache(false);
                onChange({ cacheEnabled: true });
              }}
            >
              <HardDriveDownload className="h-4 w-4" />
              {t("maintenance.cache.enable")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function StoragePaths({ settings, remoteSources }: { settings: AppSettings | null; remoteSources: FileSource[] }) {
  const { t } = useTranslation();
  const defaultSave = settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`;
  const rows: Array<[string, string]> = [
    [t("maintenance.paths.localDataRoot"), settings?.dataRoot ?? ""],
    [t("maintenance.paths.cacheRoot"), settings?.cacheRoot ?? ""],
    [
      t("maintenance.paths.remoteCachePreview"),
      storagePathPreview(`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`, "source"),
    ],
    [t("maintenance.paths.remoteSavePreview"), storagePathPreview(defaultSave, "source")],
    ...remoteSources.map((source): [string, string] => [
      source.displayName,
      storagePathPreview(source.config.saveRootTemplate || defaultSave, source.code || "source"),
    ]),
  ];
  return (
    <div className="theme-card-surface overflow-hidden rounded-xl border bg-card">
      <SettingsDisclosure title={t("maintenance.paths.title")} description={t("maintenance.paths.description")}>
        {rows.map(([label, value], index) => (
          <label
            key={`${label}:${index}`}
            className="grid gap-1 px-4 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center"
          >
            <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
            <input
              className="min-w-0 truncate bg-transparent font-mono text-xs text-foreground outline-none"
              value={value}
              readOnly
            />
          </label>
        ))}
      </SettingsDisclosure>
    </div>
  );
}

function SettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6" role="status" aria-label={t("common.loading")}>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="space-y-2.5">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
            <div className="h-9 w-full animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

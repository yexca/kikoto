import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Cloud,
  Database,
  Download,
  Folder,
  Gauge,
  HardDrive,
  LockKeyhole,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";

import { UsersPage } from "@/pages/UsersPage";
import {
  api,
  type AppSettings,
  type CacheOverview,
  type FileSource,
  type RecommendationTelemetrySummary,
} from "@/lib/api";

import i18n from "@/i18n";

const maintenanceCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`maintenance.${key}`, options);

const DATA_PREFIX = "/data";
const DEFAULT_SAVE_SUFFIX = "/<source_code>/<code_prefix>_<code_group>/<work_code>";
const DEFAULT_CACHE_SUFFIX = "/media/<source_code>/<code_prefix>/<code_group>/<work_code>";
const CACHE_GROUP_PAGE_SIZE = 50;
const LEGACY_NUMBER178_SOURCE_TYPE = "kikoeru_compatible_number178";
const REMOTE_SOURCE_TYPES = new Set(["kikoeru_compatible", LEGACY_NUMBER178_SOURCE_TYPE]);

const emptyRemoteSource = {
  id: 0,
  code: "",
  displayName: "",
  sourceType: "kikoeru_compatible",
  priority: 30,
  enabled: true,
  config: { requestLanguage: "ja-JP" },
  endpoint: {
    baseUrl: "",
    apiUrl: "",
    fallbackUrl: "",
    workUrlTemplate: "/work/{code}",
    restrictOutboundHosts: false,
    allowedHostPatterns: [],
  },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

type MaintenanceTab = "library" | "cache" | "users";

function maintenanceContentWidthClass(tab: MaintenanceTab) {
  return tab === "users" ? "w-full" : "w-full max-w-4xl";
}

export function MaintenancePage({
  canManageSources,
  canManageUsers,
  currentUserId,
  isSuperAdmin,
  canManageAccessPolicy,
  readOnly = false,
  embedded = false,
  activeTab: activeTabOverride,
  onAccessPolicyUpdated,
}: {
  canManageSources: boolean;
  canManageUsers: boolean;
  currentUserId: number;
  isSuperAdmin: boolean;
  canManageAccessPolicy: boolean;
  readOnly?: boolean;
  embedded?: boolean;
  activeTab?: MaintenanceTab;
  onAccessPolicyUpdated: () => Promise<void>;
}) {
  useTranslation();
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<MaintenanceTab>(() =>
    maintenanceTabFromLocation(canManageSources, canManageUsers, canManageAccessPolicy),
  );
  const [anonymousAccessEnabled, setAnonymousAccessEnabled] = useState(false);
  const [isAccessPolicySaving, setIsAccessPolicySaving] = useState(false);
  const [localScanDepth, setLocalScanDepth] = useState(3);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheLimitGb, setCacheLimitGb] = useState(20);
  const [transcodeCacheLimitGb, setTranscodeCacheLimitGb] = useState(5);
  const [remoteDownloadLimitGb, setRemoteDownloadLimitGb] = useState(100);
  const [fetchStagingRetentionDays, setFetchStagingRetentionDays] = useState(7);
  const [remoteDelayBase, setRemoteDelayBase] = useState(0.5);
  const [remoteDelayRandom, setRemoteDelayRandom] = useState(1.5);
  const [remoteBackoff, setRemoteBackoff] = useState(30);
  const [remoteMaxBackoff, setRemoteMaxBackoff] = useState(300);
  const [recommendationTelemetry, setRecommendationTelemetry] = useState<RecommendationTelemetrySummary | null>(null);
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [checkingSourceId, setCheckingSourceId] = useState<number | null>(null);
  const [sourcePendingDelete, setSourcePendingDelete] = useState<FileSource | null>(null);
  const [deletingSourceId, setDeletingSourceId] = useState<number | null>(null);
  const openedLinkedSource = useRef(false);

  useEffect(() => {
    if (activeTabOverride && activeTabOverride !== activeTab) setActiveTab(activeTabOverride);
  }, [activeTab, activeTabOverride]);

  const remoteSources = useMemo(
    () => settings?.fileSources.filter((source) => REMOTE_SOURCE_TYPES.has(source.sourceType)) ?? [],
    [settings],
  );
  const localSource = settings?.fileSources.find((source) => source.sourceType === "local_folder") ?? null;

  const reload = () =>
    api
      .getSettings()
      .then((next) => {
        setSettings(next);
        setAnonymousAccessEnabled(next.anonymousAccessEnabled);
        setLocalScanDepth(next.localScanDepth);
        setCacheEnabled(next.cacheEnabled);
        setCacheLimitGb(next.cacheLimitGb);
        setTranscodeCacheLimitGb(next.transcodeCacheLimitGb ?? 5);
        setRemoteDownloadLimitGb(next.remoteDownloadLimitGb);
        setFetchStagingRetentionDays(next.fetchStagingRetentionDays);
        setRemoteDelayBase(next.remoteDelayBaseSeconds);
        setRemoteDelayRandom(next.remoteDelayRandomSeconds);
        setRemoteBackoff(next.remoteBackoffSeconds);
        setRemoteMaxBackoff(next.remoteMaxBackoffSeconds);
      })
      .catch((error) => toast.notify(toastFromError(error, maintenanceCopy("settingsApiUnavailable"))))
      .finally(() => setIsSettingsLoading(false));

  useEffect(() => {
    if (!canManageSources && !canManageAccessPolicy) {
      setIsSettingsLoading(false);
      return;
    }
    void reload();
  }, [canManageSources, canManageAccessPolicy]);

  useEffect(() => {
    if (activeTab !== "library" || !canManageSources) return;
    void api
      .getRecommendationTelemetry()
      .then(setRecommendationTelemetry)
      .catch(() => setRecommendationTelemetry(null));
  }, [activeTab, canManageSources]);

  useEffect(() => {
    if (maintenanceTabIsAvailable(activeTab, { canManageSources, canManageUsers, canManageAccessPolicy })) return;
    setActiveTab(maintenanceTabFromLocation(canManageSources, canManageUsers, canManageAccessPolicy));
  }, [activeTab, canManageAccessPolicy, canManageSources, canManageUsers]);

  useEffect(() => {
    if (openedLinkedSource.current || readOnly || !settings) return;
    const sourceID = Number(new URLSearchParams(window.location.search).get("source"));
    if (!Number.isInteger(sourceID) || sourceID <= 0) return;
    const source = settings.fileSources.find(
      (candidate) => candidate.id === sourceID && REMOTE_SOURCE_TYPES.has(candidate.sourceType),
    );
    if (!source) return;
    openedLinkedSource.current = true;
    setActiveTab("library");
    setDraftSource(source);
    setEditingSourceId(source.id);
    setIsSourceModalOpen(true);
  }, [readOnly, settings]);

  useEffect(() => {
    if (activeTab !== "library" || window.location.hash !== "#remote-sources") return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("remote-sources")?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, isSettingsLoading, settings]);

  const selectTab = (tab: MaintenanceTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.pathname = embedded ? "/settings" : "/maintenance";
    url.searchParams.delete("source");
    if (tab !== activeTab) {
      url.searchParams.delete("metadataRun");
      url.searchParams.delete("reason");
    }
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const saveRuntimeSettings = async () => {
    if (readOnly) return;
    const next = await api.updateSettings({
      localScanDepth,
      cacheEnabled,
      cacheLimitGb,
      transcodeCacheLimitGb,
      remoteDownloadLimitGb,
      fetchStagingRetentionDays,
      remoteDelayBaseSeconds: remoteDelayBase,
      remoteDelayRandomSeconds: remoteDelayRandom,
      remoteBackoffSeconds: remoteBackoff,
      remoteMaxBackoffSeconds: remoteMaxBackoff,
    });
    setSettings(next);
    setCacheEnabled(next.cacheEnabled);
    setCacheLimitGb(next.cacheLimitGb);
    setTranscodeCacheLimitGb(next.transcodeCacheLimitGb ?? 5);
    setRemoteDownloadLimitGb(next.remoteDownloadLimitGb);
    setFetchStagingRetentionDays(next.fetchStagingRetentionDays);
    toast.success(maintenanceCopy("settingsSaved"));
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
        toast.warning(maintenanceCopy("accessPolicyRefreshFailed"));
        return;
      }
      toast.success(maintenanceCopy("accessPolicySaved"));
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("accessPolicySaveFailed")));
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
    if (readOnly) return;
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
    const payload = {
      displayName: draftSource.displayName,
      sourceType: draftSource.sourceType,
      priority: draftSource.priority,
      enabled: draftSource.enabled,
      config: draftSource.config,
      endpoint: draftSource.endpoint,
    };
    if (editingSourceId) {
      await api.updateFileSource(editingSourceId, payload);
    } else {
      await api.createFileSource(payload);
    }
    closeSourceModal();
    await reload();
    toast.success(maintenanceCopy("sourceSaved"));
  };

  const requestDeleteSource = (source: FileSource) => {
    if (readOnly) return;
    setSourcePendingDelete(source);
  };

  const deleteSource = async () => {
    if (readOnly || !sourcePendingDelete) return;
    const source = sourcePendingDelete;
    setDeletingSourceId(source.id);
    try {
      await api.deleteFileSource(source.id);
      setSettings((current) =>
        current
          ? {
              ...current,
              fileSources: current.fileSources.filter((candidate) => candidate.id !== source.id),
            }
          : current,
      );
      setSourcePendingDelete(null);
      toast.success(maintenanceCopy("sourceDeleted"));
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("sourceDeleteFailed")));
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
                  ? {
                      ...source,
                      healthStatus: result.healthStatus,
                      lastCheckedAt: result.lastCheckedAt,
                    }
                  : source,
              ),
            }
          : current,
      );
      if (result.healthy) toast.success(maintenanceCopy("sourceHealthPassed"));
      else toast.warning(maintenanceCopy("sourceHealthFailed"));
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("sourceHealthCheckFailed")));
    } finally {
      setCheckingSourceId(null);
    }
  };

  if (!canManageSources && !canManageUsers && !canManageAccessPolicy) {
    return (
      <section className="rounded-lg border bg-card p-5">
        <p className="text-sm text-muted-foreground">{maintenanceCopy("adminRequired")}</p>
      </section>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      {readOnly && (
        <div
          className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          {maintenanceCopy("demoReadOnly")}
        </div>
      )}

      {!embedded && (
        <nav
          className="flex flex-nowrap gap-1 overflow-x-auto rounded-lg border bg-card p-2"
          aria-label={maintenanceCopy("navigation")}
        >
          {canManageSources && (
            <>
              <SettingsTabButton
                active={activeTab === "library"}
                onClick={() => selectTab("library")}
                icon={<Folder className="h-4 w-4" />}
              >
                {maintenanceCopy("tabs.library")}
              </SettingsTabButton>
              <SettingsTabButton
                active={activeTab === "cache"}
                onClick={() => selectTab("cache")}
                icon={<Download className="h-4 w-4" />}
              >
                {maintenanceCopy("tabs.cache")}
              </SettingsTabButton>
            </>
          )}
          {(canManageUsers || canManageAccessPolicy) && (
            <SettingsTabButton
              active={activeTab === "users"}
              onClick={() => selectTab("users")}
              icon={<Shield className="h-4 w-4" />}
            >
              {maintenanceCopy("tabs.users")}
            </SettingsTabButton>
          )}
        </nav>
      )}

      <fieldset
        data-testid="maintenance-content"
        disabled={readOnly}
        className={`min-w-0 border-0 p-0 ${maintenanceContentWidthClass(activeTab)}`}
      >
        {isSettingsLoading && activeTab !== "users" ? (
          activeTab === "library" ? (
            <RemoteSourcesSettingsSkeleton />
          ) : (
            <SettingsPanelSkeleton />
          )
        ) : activeTab === "library" ? (
          <div className="space-y-4">
            <LocalLibrarySettings
              localSource={localSource}
              localScanDepth={localScanDepth}
              onScanDepthChange={setLocalScanDepth}
              onSave={saveRuntimeSettings}
            />
            <RemoteSourcesSettings
              remoteSources={remoteSources}
              checkingSourceId={checkingSourceId}
              onCreateSource={openCreateSource}
              onEditSource={openEditSource}
              onDeleteSource={requestDeleteSource}
              onCheckSource={checkSourceHealth}
            />
            <PathsSettings settings={settings} remoteSources={remoteSources} />
            <details className="rounded-lg border bg-card">
              <summary className="cursor-pointer p-4 text-sm font-medium">
                {maintenanceCopy("recommendation.localTelemetry")}
              </summary>
              <RecommendationTelemetry telemetry={recommendationTelemetry} />
            </details>
          </div>
        ) : activeTab === "cache" ? (
          <CacheFetchSettings
            cacheEnabled={cacheEnabled}
            cacheLimitGb={cacheLimitGb}
            transcodeCacheLimitGb={transcodeCacheLimitGb}
            remoteDownloadLimitGb={remoteDownloadLimitGb}
            fetchStagingRetentionDays={fetchStagingRetentionDays}
            remoteDelayBase={remoteDelayBase}
            remoteDelayRandom={remoteDelayRandom}
            remoteBackoff={remoteBackoff}
            remoteMaxBackoff={remoteMaxBackoff}
            onCacheEnabledChange={setCacheEnabled}
            onCacheLimitChange={setCacheLimitGb}
            onTranscodeCacheLimitChange={setTranscodeCacheLimitGb}
            onRemoteDownloadLimitChange={setRemoteDownloadLimitGb}
            onFetchStagingRetentionChange={setFetchStagingRetentionDays}
            onRemoteDelayBaseChange={setRemoteDelayBase}
            onRemoteDelayRandomChange={setRemoteDelayRandom}
            onRemoteBackoffChange={setRemoteBackoff}
            onRemoteMaxBackoffChange={setRemoteMaxBackoff}
            onSave={saveRuntimeSettings}
          />
        ) : (
          <div className="space-y-4">
            {canManageUsers && (
              <UsersPage currentUserId={currentUserId} isSuperAdmin={isSuperAdmin} readOnly={readOnly} embedded />
            )}
            {canManageAccessPolicy && (
              <div className="max-w-4xl">
                {isSettingsLoading ? (
                  <SettingsPanelSkeleton />
                ) : (
                  <AccessPolicySettings
                    anonymousAccessEnabled={anonymousAccessEnabled}
                    savedAnonymousAccessEnabled={settings?.anonymousAccessEnabled ?? false}
                    saving={isAccessPolicySaving}
                    onAnonymousAccessEnabledChange={setAnonymousAccessEnabled}
                    onSave={saveAccessPolicy}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {isSourceModalOpen && (
        <SourceModal
          source={draftSource}
          defaultSaveTemplate={settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`}
          editing={editingSourceId !== null}
          onChange={setDraftSource}
          onSave={saveSource}
          onClose={closeSourceModal}
        />
      )}
      {sourcePendingDelete && (
        <SourceDeleteDialog
          source={sourcePendingDelete}
          deleting={deletingSourceId === sourcePendingDelete.id}
          onConfirm={deleteSource}
          onClose={() => setSourcePendingDelete(null)}
        />
      )}
    </div>
  );
}

function AccessPolicySettings({
  anonymousAccessEnabled,
  savedAnonymousAccessEnabled,
  saving,
  onAnonymousAccessEnabledChange,
  onSave,
}: {
  anonymousAccessEnabled: boolean;
  savedAnonymousAccessEnabled: boolean;
  saving: boolean;
  onAnonymousAccessEnabledChange: (enabled: boolean) => void;
  onSave: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyhole className="h-4 w-4" />
          {maintenanceCopy("access.instance")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">{maintenanceCopy("access.anonymous")}</div>
            <div className="text-xs text-muted-foreground">{maintenanceCopy("access.anonymousDescription")}</div>
          </div>
          <Switch
            checked={anonymousAccessEnabled}
            onCheckedChange={onAnonymousAccessEnabledChange}
            aria-label={maintenanceCopy("access.anonymous")}
          />
        </div>
        <Button
          size="sm"
          disabled={saving || anonymousAccessEnabled === savedAnonymousAccessEnabled}
          onClick={() => void onSave()}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {maintenanceCopy("access.save")}
        </Button>
      </CardContent>
    </Card>
  );
}

function SettingsSkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function SettingsPanelSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SettingsSkeletonLine className="h-8 w-8 rounded-md" />
          <SettingsSkeletonLine className="h-5 w-36" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-lg border bg-background p-3">
              <SettingsSkeletonLine className="h-9 w-9 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <SettingsSkeletonLine className="h-3 w-20" />
                <SettingsSkeletonLine className="h-4 w-24" />
              </div>
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <SettingsSkeletonLine className="h-16 w-full" />
          <SettingsSkeletonLine className="h-16 w-full" />
        </div>
        <SettingsSkeletonLine className="h-9 w-32 rounded-md" />
      </CardContent>
    </Card>
  );
}

function RemoteSourcesSettingsSkeleton() {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <SettingsSkeletonLine className="h-5 w-36" />
            <SettingsSkeletonLine className="h-4 w-72 max-w-full" />
          </div>
          <SettingsSkeletonLine className="h-8 w-28 rounded-md" />
        </div>
        <div className="flex gap-2">
          <SettingsSkeletonLine className="h-5 w-24 rounded-full" />
          <SettingsSkeletonLine className="h-5 w-20 rounded-full" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="space-y-3 rounded-lg border bg-background p-3">
              <div className="flex items-center justify-between gap-3">
                <SettingsSkeletonLine className="h-4 w-32" />
                <div className="flex gap-1">
                  <SettingsSkeletonLine className="h-8 w-8 rounded-md" />
                  <SettingsSkeletonLine className="h-8 w-8 rounded-md" />
                </div>
              </div>
              <SettingsSkeletonLine className="h-8 w-full rounded-md" />
              <SettingsSkeletonLine className="h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LocalLibrarySettings({
  localSource,
  localScanDepth,
  onScanDepthChange,
  onSave,
}: {
  localSource: FileSource | null;
  localScanDepth: number;
  onScanDepthChange: (value: number) => void;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Folder className="h-4 w-4" />
            </span>
            {maintenanceCopy("library.local")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">{maintenanceCopy("library.scanDepth")}</span>
              <Input
                fieldSize="sm"
                type="number"
                min={1}
                max={8}
                value={localScanDepth}
                onChange={(event) => onScanDepthChange(Number(event.target.value))}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <Badge variant="secondary">{localSource?.displayName ?? maintenanceCopy("mainLocalLibrary")}</Badge>
              <Badge variant="outline">
                {localSource?.enabled ? maintenanceCopy("status.enabled") : maintenanceCopy("status.notScanned")}
              </Badge>
            </div>
          </div>
          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            {maintenanceCopy("library.save")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function RemoteSourcesSettings({
  remoteSources,
  checkingSourceId,
  onCreateSource,
  onEditSource,
  onDeleteSource,
  onCheckSource,
}: {
  remoteSources: FileSource[];
  checkingSourceId: number | null;
  onCreateSource: () => void;
  onEditSource: (source: FileSource) => void;
  onDeleteSource: (source: FileSource) => void;
  onCheckSource: (id: number) => Promise<void>;
}) {
  const enabledSources = remoteSources.filter((source) => source.enabled).length;
  const attentionSources = remoteSources.filter(
    (source) => source.enabled && ["error", "unavailable"].includes(source.healthStatus),
  ).length;
  return (
    <Card id="remote-sources" className="overflow-hidden">
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <Database className="h-4 w-4" />
              </span>
              {maintenanceCopy("library.remoteSources")}
            </CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">{maintenanceCopy("library.remoteSourcesDescription")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreateSource}>
            <Plus className="h-4 w-4" />
            {maintenanceCopy("library.addSource")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{maintenanceCopy("configuredCount", { count: remoteSources.length })}</Badge>
          <Badge variant="outline">{maintenanceCopy("enabledCountShort", { count: enabledSources })}</Badge>
          {attentionSources > 0 && (
            <Badge variant="warning">{maintenanceCopy("needAttentionCount", { count: attentionSources })}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]">
          {remoteSources.map((source) => {
            const endpoint =
              source.endpoint.baseUrl || source.endpoint.apiUrl || maintenanceCopy("noEndpointConfigured");
            const health = source.enabled ? source.healthStatus || "unknown" : "disabled";
            const unhealthy = source.enabled && ["error", "unavailable"].includes(source.healthStatus);
            return (
              <article key={source.id} className="min-w-0 space-y-3 rounded-lg border bg-background p-3">
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <div className="min-w-0 pt-1">
                    <div className="truncate text-sm font-semibold" title={source.displayName}>
                      {source.displayName}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={maintenanceCopy("library.configure")}
                      title={maintenanceCopy("library.configure")}
                      onClick={() => onEditSource(source)}
                    >
                      <Settings2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label={maintenanceCopy("library.deleteSource")}
                      title={maintenanceCopy("library.deleteSource")}
                      onClick={() => onDeleteSource(source)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 border-y py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Badge
                      variant={source.enabled ? "outline" : "warning"}
                      className={`max-w-28 truncate ${unhealthy ? "border-error-border bg-error-surface text-error-foreground" : ""}`}
                      title={health}
                    >
                      {health}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={maintenanceCopy("library.checkHealth")}
                      title={maintenanceCopy("library.checkHealth")}
                      onClick={() => void onCheckSource(source.id)}
                      disabled={!source.enabled || checkingSourceId !== null}
                    >
                      <RefreshCw className={`h-4 w-4 ${checkingSourceId === source.id ? "animate-spin" : ""}`} />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <div className="min-w-0">
                    <div className="text-2xs font-medium text-muted-foreground">
                      {maintenanceCopy("library.endpoint")}
                    </div>
                    <div className="truncate text-xs" title={endpoint}>
                      {endpoint}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xs font-medium text-muted-foreground">
                      {maintenanceCopy("library.priority")}
                    </div>
                    <div className="text-xs font-semibold">{source.priority}</div>
                  </div>
                </div>
              </article>
            );
          })}
          {remoteSources.length === 0 && (
            <div className="rounded-lg border border-dashed bg-background px-4 py-6 text-center text-sm text-muted-foreground sm:col-span-full">
              No remote sources configured yet.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CacheFetchSettings({
  cacheEnabled,
  cacheLimitGb,
  transcodeCacheLimitGb,
  remoteDownloadLimitGb,
  fetchStagingRetentionDays,
  remoteDelayBase,
  remoteDelayRandom,
  remoteBackoff,
  remoteMaxBackoff,
  onCacheEnabledChange,
  onCacheLimitChange,
  onTranscodeCacheLimitChange,
  onRemoteDownloadLimitChange,
  onFetchStagingRetentionChange,
  onRemoteDelayBaseChange,
  onRemoteDelayRandomChange,
  onRemoteBackoffChange,
  onRemoteMaxBackoffChange,
  onSave,
}: {
  cacheEnabled: boolean;
  cacheLimitGb: number;
  transcodeCacheLimitGb: number;
  remoteDownloadLimitGb: number;
  fetchStagingRetentionDays: number;
  remoteDelayBase: number;
  remoteDelayRandom: number;
  remoteBackoff: number;
  remoteMaxBackoff: number;
  onCacheEnabledChange: (value: boolean) => void;
  onCacheLimitChange: (value: number) => void;
  onTranscodeCacheLimitChange: (value: number) => void;
  onRemoteDownloadLimitChange: (value: number) => void;
  onFetchStagingRetentionChange: (value: number) => void;
  onRemoteDelayBaseChange: (value: number) => void;
  onRemoteDelayRandomChange: (value: number) => void;
  onRemoteBackoffChange: (value: number) => void;
  onRemoteMaxBackoffChange: (value: number) => void;
  onSave: () => Promise<void>;
}) {
  const toast = useToast();
  const [overview, setOverview] = useState<CacheOverview | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [isClearingTranscodes, setIsClearingTranscodes] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmTranscodeCleanup, setConfirmTranscodeCleanup] = useState(false);
  const [confirmEnableCache, setConfirmEnableCache] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
  const [transcodeCleanupStatus, setTranscodeCleanupStatus] = useState("");
  const [cleanupMode, setCleanupMode] = useState<"orphans" | "works">("orphans");
  const [selectedCleanupKeys, setSelectedCleanupKeys] = useState<Set<string>>(new Set());
  const [expandedCleanupGroups, setExpandedCleanupGroups] = useState<Set<string>>(new Set());
  const [cleanupGroupLimits, setCleanupGroupLimits] = useState<Map<string, number>>(new Map());
  const cleanupRows = useMemo(() => cacheCleanupRows(overview, cleanupMode), [cleanupMode, overview]);
  const cleanupGroups = useMemo(() => cacheCleanupGroups(cleanupRows), [cleanupRows]);
  const selectedCleanupRows = cleanupRows.filter((row) => selectedCleanupKeys.has(row.key));

  const setCleanupRowsSelected = (rows: CacheCleanupRow[], checked: boolean) => {
    setSelectedCleanupKeys((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (checked) next.add(row.key);
        else next.delete(row.key);
      }
      return next;
    });
    setConfirmCleanup(false);
  };

  const toggleCleanupGroup = (groupKey: string) => {
    setExpandedCleanupGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
    setCleanupGroupLimits((current) =>
      current.has(groupKey) ? current : new Map(current).set(groupKey, CACHE_GROUP_PAGE_SIZE),
    );
  };

  const showMoreCleanupRows = (groupKey: string) => {
    setCleanupGroupLimits((current) =>
      new Map(current).set(groupKey, (current.get(groupKey) ?? CACHE_GROUP_PAGE_SIZE) + CACHE_GROUP_PAGE_SIZE),
    );
  };

  const scanCache = async () => {
    setIsScanning(true);
    try {
      setOverview(await api.getCacheOverview());
      setSelectedCleanupKeys(new Set());
      setConfirmCleanup(false);
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("cache.scanFailed")));
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    void scanCache();
  }, []);

  const handleCacheEnabledChange = (enabled: boolean) => {
    if (enabled && !cacheEnabled) {
      setConfirmEnableCache(true);
      return;
    }
    setConfirmEnableCache(false);
    onCacheEnabledChange(enabled);
  };

  const cleanupCache = async () => {
    if (!confirmCleanup) {
      setConfirmCleanup(true);
      return;
    }
    setIsCleaning(true);
    try {
      const result =
        cleanupMode === "orphans"
          ? await api.cleanupCache({ mode: "orphans", groupKeys: selectedCleanupRows.map((row) => row.key) })
          : await api.cleanupCache({ mode: "works", workIds: selectedCleanupRows.map((row) => row.workId) });
      setConfirmCleanup(false);
      setSelectedCleanupKeys(new Set());
      setCleanupStatus(
        result.status === "succeeded"
          ? maintenanceCopy("cache.noEligibleOrphans")
          : maintenanceCopy("cache.cleanupQueued", { runId: result.runId, count: result.queued }),
      );
      toast.success(
        result.status === "succeeded"
          ? maintenanceCopy("cache.alreadyClean")
          : maintenanceCopy("cache.cleanupQueuedToast"),
      );
      await scanCache();
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("cache.cleanupFailed")));
    } finally {
      setIsCleaning(false);
    }
  };

  const clearTranscodeCache = async () => {
    if (!confirmTranscodeCleanup) {
      setConfirmTranscodeCleanup(true);
      return;
    }
    setIsClearingTranscodes(true);
    try {
      const result = await api.clearTranscodeCache();
      setConfirmTranscodeCleanup(false);
      setTranscodeCleanupStatus(
        result.deletedFiles > 0
          ? maintenanceCopy("cache.transcodeRemoved", {
              count: result.deletedFiles,
              size: formatByteSize(result.freedBytes),
            })
          : maintenanceCopy("cache.transcodeEmpty"),
      );
      toast.success(
        result.deletedFiles > 0 ? maintenanceCopy("cache.transcodeCleared") : maintenanceCopy("cache.transcodeEmpty"),
      );
      await scanCache();
    } catch (error) {
      toast.notify(toastFromError(error, maintenanceCopy("cache.transcodeClearFailed")));
    } finally {
      setIsClearingTranscodes(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden" data-testid="cache-configuration-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Settings2 className="h-4 w-4" />
            </span>
            {maintenanceCopy("cache.configuration")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-hidden rounded-md border">
            <ConfigurationSectionLabel>{maintenanceCopy("cache.policy")}</ConfigurationSectionLabel>
            <ConfigurationRow
              title={maintenanceCopy("cache.remotePlayback")}
              description={maintenanceCopy("cache.remotePlaybackDescription")}
            >
              <Switch
                checked={cacheEnabled}
                onCheckedChange={handleCacheEnabledChange}
                aria-label={maintenanceCopy("cache.remotePlayback")}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.limit")}
              description={maintenanceCopy("cache.limitDescription")}
            >
              <div className="flex h-9 w-full overflow-hidden rounded-md border bg-card sm:w-44">
                <input
                  aria-label={maintenanceCopy("cache.limit")}
                  className="min-w-0 flex-1 bg-transparent px-3 text-right outline-none focus:ring-2 focus:ring-ring"
                  type="number"
                  min={0}
                  value={cacheLimitGb}
                  onChange={(event) => onCacheLimitChange(Number(event.target.value))}
                />
                <span className="flex items-center border-l bg-muted px-3 text-xs text-muted-foreground">GB</span>
              </div>
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.transcodeLimit")}
              description={maintenanceCopy("cache.transcodeLimitDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.transcodeLimit")}
                value={transcodeCacheLimitGb}
                min={1}
                max={4096}
                step={1}
                unit="GB"
                onChange={onTranscodeCacheLimitChange}
              />
            </ConfigurationRow>

            <ConfigurationSectionLabel>{maintenanceCopy("cache.transferSafety")}</ConfigurationSectionLabel>
            <ConfigurationRow
              title={maintenanceCopy("cache.downloadLimit")}
              description={maintenanceCopy("cache.downloadLimitDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.downloadLimit")}
                value={remoteDownloadLimitGb}
                min={1}
                max={2048}
                step={1}
                unit="GB"
                onChange={onRemoteDownloadLimitChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.stagingRetention")}
              description={maintenanceCopy("cache.stagingRetentionDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.stagingRetention")}
                value={fetchStagingRetentionDays}
                min={1}
                max={365}
                step={1}
                unit="days"
                onChange={onFetchStagingRetentionChange}
              />
            </ConfigurationRow>

            <ConfigurationSectionLabel>{maintenanceCopy("cache.downloadPacing")}</ConfigurationSectionLabel>
            <ConfigurationRow
              title={maintenanceCopy("cache.baseDelay")}
              description={maintenanceCopy("cache.baseDelayDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.baseDelay")}
                value={remoteDelayBase}
                min={0}
                step={0.1}
                onChange={onRemoteDelayBaseChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.randomDelay")}
              description={maintenanceCopy("cache.randomDelayDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.randomDelay")}
                value={remoteDelayRandom}
                min={0}
                step={0.1}
                onChange={onRemoteDelayRandomChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.initialBackoff")}
              description={maintenanceCopy("cache.initialBackoffDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.initialBackoff")}
                value={remoteBackoff}
                min={0}
                step={1}
                onChange={onRemoteBackoffChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title={maintenanceCopy("cache.maximumBackoff")}
              description={maintenanceCopy("cache.maximumBackoffDescription")}
            >
              <ConfigurationNumberInput
                label={maintenanceCopy("cache.maximumBackoff")}
                value={remoteMaxBackoff}
                min={0}
                step={1}
                onChange={onRemoteMaxBackoffChange}
              />
            </ConfigurationRow>
          </div>

          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            {maintenanceCopy("cache.save")}
          </Button>
        </CardContent>
      </Card>

      <Card role="region" aria-label={maintenanceCopy("cache.transcodeCache")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-4 w-4" />
            {maintenanceCopy("cache.transcodeCache")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <CacheMetric
              label={maintenanceCopy("cache.onDisk")}
              value={overview ? formatByteSize(overview.transcode.bytes) : "--"}
              detail={
                overview
                  ? maintenanceCopy("cache.segments", { count: overview.transcode.files })
                  : maintenanceCopy("cache.scanning")
              }
            />
            <CacheMetric
              label={maintenanceCopy("cache.limitShort")}
              value={overview ? formatByteSize(overview.transcode.limitBytes) : `${transcodeCacheLimitGb} GB`}
              detail={maintenanceCopy("cache.independent")}
            />
            <CacheMetric
              label={maintenanceCopy("cache.available")}
              value={
                overview ? formatByteSize(Math.max(0, overview.transcode.limitBytes - overview.transcode.bytes)) : "--"
              }
              detail={maintenanceCopy("cache.lruSpace")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void clearTranscodeCache()}
              disabled={isClearingTranscodes || isScanning || !overview}
            >
              <Trash2 className="h-4 w-4" />
              {isClearingTranscodes
                ? maintenanceCopy("cache.clearing")
                : confirmTranscodeCleanup
                  ? maintenanceCopy("cache.confirmClear", { count: overview?.transcode.files ?? 0 })
                  : maintenanceCopy("cache.clearTranscode")}
            </Button>
            {confirmTranscodeCleanup && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmTranscodeCleanup(false)}>
                {maintenanceCopy("cancel")}
              </Button>
            )}
            {transcodeCleanupStatus && <span className="text-xs text-muted-foreground">{transcodeCleanupStatus}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            {maintenanceCopy("cache.managedCache")}
          </CardTitle>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void scanCache()}
            disabled={isScanning}
            aria-label={maintenanceCopy("cache.refreshOverview")}
            title={maintenanceCopy("cache.refreshOverview")}
          >
            <RefreshCw className={`h-4 w-4 ${isScanning ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CacheMetric
              label={maintenanceCopy("cache.onDisk")}
              value={overview ? formatByteSize(overview.mediaBytes) : "--"}
              detail={
                overview
                  ? maintenanceCopy("cache.files", { count: overview.mediaFiles })
                  : maintenanceCopy("cache.scanning")
              }
            />
            <CacheMetric
              label={maintenanceCopy("cache.referenced")}
              value={overview ? formatByteSize(overview.referencedBytes) : "--"}
              detail={
                overview
                  ? maintenanceCopy("cache.files", { count: overview.referencedFiles })
                  : maintenanceCopy("cache.scanning")
              }
            />
            <CacheMetric
              label={maintenanceCopy("cache.eligibleCleanup")}
              value={overview ? formatByteSize(overview.orphanBytes) : "--"}
              detail={
                overview
                  ? maintenanceCopy("cache.files", { count: overview.orphanFiles })
                  : maintenanceCopy("cache.scanning")
              }
              tone={overview?.orphanFiles ? "warning" : "default"}
            />
            <CacheMetric
              label={maintenanceCopy("cache.protected")}
              value={overview ? String(overview.protectedFiles) : "--"}
              detail={maintenanceCopy("cache.protectedDescription")}
            />
          </div>

          {overview && (overview.missingReferences > 0 || overview.emptyDirectories > 0) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>{maintenanceCopy("cache.missingReferences", { count: overview.missingReferences })}</span>
              <span>{maintenanceCopy("cache.emptyDirectories", { count: overview.emptyDirectories })}</span>
            </div>
          )}

          <div
            className="inline-flex rounded-md border bg-muted/40 p-1"
            aria-label={maintenanceCopy("cache.cleanupMode")}
          >
            <button
              className={`h-8 rounded px-3 text-sm font-medium ${cleanupMode === "orphans" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              aria-pressed={cleanupMode === "orphans"}
              onClick={() => {
                setCleanupMode("orphans");
                setSelectedCleanupKeys(new Set());
                setExpandedCleanupGroups(new Set());
                setCleanupGroupLimits(new Map());
                setConfirmCleanup(false);
              }}
            >
              {maintenanceCopy("cache.orphanCache")}
            </button>
            <button
              className={`h-8 rounded px-3 text-sm font-medium ${cleanupMode === "works" ? "bg-background shadow-sm" : "text-muted-foreground"}`}
              aria-pressed={cleanupMode === "works"}
              onClick={() => {
                setCleanupMode("works");
                setSelectedCleanupKeys(new Set());
                setExpandedCleanupGroups(new Set());
                setCleanupGroupLimits(new Map());
                setConfirmCleanup(false);
              }}
            >
              {maintenanceCopy("cache.workCache")}
            </button>
          </div>

          {cleanupRows.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                <Checkbox
                  checked={selectedCleanupKeys.size === cleanupRows.length}
                  indeterminate={selectedCleanupKeys.size > 0 && selectedCleanupKeys.size < cleanupRows.length}
                  onCheckedChange={(checked) => setCleanupRowsSelected(cleanupRows, checked)}
                  aria-label={maintenanceCopy("cache.selectAll", {
                    target:
                      cleanupMode === "orphans"
                        ? maintenanceCopy("cache.orphanGroups")
                        : maintenanceCopy("cache.workCaches"),
                  })}
                />
                <span>
                  {maintenanceCopy("cache.groupSummary", { groups: cleanupGroups.length, works: cleanupRows.length })}
                </span>
                <span>{maintenanceCopy("cache.filesLabel")}</span>
                <span>{maintenanceCopy("cache.size")}</span>
              </div>
              <div className="app-scroll max-h-[28rem] overflow-y-auto">
                {cleanupGroups.map((group) => {
                  const selectedInGroup = group.rows.filter((row) => selectedCleanupKeys.has(row.key)).length;
                  const expanded = expandedCleanupGroups.has(group.key);
                  const visibleRows = group.rows.slice(0, cleanupGroupLimits.get(group.key) ?? CACHE_GROUP_PAGE_SIZE);
                  const remainingRows = group.rows.length - visibleRows.length;
                  return (
                    <section key={group.key} className="border-b last:border-b-0">
                      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 bg-muted/25 px-3 py-2.5">
                        <Checkbox
                          checked={selectedInGroup === group.rows.length}
                          indeterminate={selectedInGroup > 0 && selectedInGroup < group.rows.length}
                          onCheckedChange={(checked) => setCleanupRowsSelected(group.rows, checked)}
                          aria-label={maintenanceCopy("cache.selectGroup", { group: group.label })}
                        />
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2 text-left"
                          aria-expanded={expanded}
                          aria-label={maintenanceCopy(expanded ? "cache.collapseGroup" : "cache.expandGroup", {
                            group: group.label,
                          })}
                          onClick={() => toggleCleanupGroup(group.key)}
                        >
                          <ChevronDown
                            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{group.label}</span>
                            <span className="block text-xs text-muted-foreground">
                              {maintenanceCopy("cache.workCount", { count: group.rows.length })}
                            </span>
                          </span>
                        </button>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{group.files}</span>
                        <span
                          className={`whitespace-nowrap text-xs font-semibold ${cleanupMode === "orphans" ? "text-destructive" : ""}`}
                        >
                          {formatByteSize(group.bytes)}
                        </span>
                      </div>
                      {expanded &&
                        visibleRows.map((row) => (
                          <div
                            key={row.key}
                            className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-t bg-background px-3 py-2 pl-9 text-sm"
                          >
                            <Checkbox
                              checked={selectedCleanupKeys.has(row.key)}
                              onCheckedChange={(checked) => setCleanupRowsSelected([row], checked)}
                              aria-label={maintenanceCopy("cache.selectWork", { code: row.workCode })}
                            />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{row.workCode}</div>
                              <div className="truncate text-xs text-muted-foreground">{row.sourceLabel}</div>
                            </div>
                            <span className="whitespace-nowrap text-xs text-muted-foreground">{row.files}</span>
                            <span
                              className={`whitespace-nowrap text-xs font-medium ${cleanupMode === "orphans" ? "text-destructive" : ""}`}
                            >
                              {formatByteSize(row.bytes)}
                            </span>
                          </div>
                        ))}
                      {expanded && remainingRows > 0 && (
                        <button
                          type="button"
                          className="w-full border-t bg-background px-3 py-2 text-xs font-medium text-primary hover:bg-muted/40"
                          onClick={() => showMoreCleanupRows(group.key)}
                        >
                          {maintenanceCopy("cache.showMore", {
                            count: Math.min(CACHE_GROUP_PAGE_SIZE, remainingRows),
                            group: group.label,
                          })}
                        </button>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>
          )}

          {overview && cleanupRows.length === 0 && (
            <div className="rounded-md border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              {cleanupMode === "orphans"
                ? maintenanceCopy("cache.noEligibleGroups")
                : maintenanceCopy("cache.noReferencedCache")}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void cleanupCache()}
              disabled={isCleaning || isScanning || selectedCleanupRows.length === 0}
            >
              <Trash2 className="h-4 w-4" />
              {isCleaning
                ? maintenanceCopy("cache.queueingCleanup")
                : confirmCleanup
                  ? maintenanceCopy("cache.confirmCleanup", {
                      count: selectedCleanupRows.reduce((total, row) => total + row.files, 0),
                    })
                  : maintenanceCopy("cache.cleanSelected", {
                      target:
                        cleanupMode === "orphans" ? maintenanceCopy("cache.orphans") : maintenanceCopy("cache.works"),
                    })}
            </Button>
            {confirmCleanup && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmCleanup(false)}>
                {maintenanceCopy("cancel")}
              </Button>
            )}
            {cleanupStatus && <span className="text-xs text-muted-foreground">{cleanupStatus}</span>}
          </div>
        </CardContent>
      </Card>
      {confirmEnableCache && (
        <Dialog onClose={() => setConfirmEnableCache(false)} layer="sheet" size="lg" role="alertdialog">
          <DialogHeader
            title={maintenanceCopy("cache.enableTitle")}
            description={maintenanceCopy("cache.enableDescription")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmEnableCache(false)}>
              {maintenanceCopy("cancel")}
            </Button>
            <Button
              onClick={() => {
                setConfirmEnableCache(false);
                onCacheEnabledChange(true);
              }}
            >
              <Download className="h-4 w-4" />
              {maintenanceCopy("cache.enable")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}

function ConfigurationSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="border-b bg-muted/35 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function ConfigurationRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-3 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="flex w-full shrink-0 justify-end sm:w-auto">{children}</div>
    </div>
  );
}

function ConfigurationNumberInput({
  label,
  value,
  min,
  max,
  step,
  unit = "sec",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-9 w-full overflow-hidden rounded-md border bg-card sm:w-44">
      <input
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent px-3 text-right outline-none focus:ring-2 focus:ring-ring"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="flex items-center border-l bg-muted px-3 text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

type CacheCleanupRow = {
  key: string;
  workId: number;
  workCode: string;
  groupKey: string;
  groupLabel: string;
  sourceLabel: string;
  files: number;
  bytes: number;
};

type CacheCleanupGroup = {
  key: string;
  label: string;
  rows: CacheCleanupRow[];
  files: number;
  bytes: number;
};

function cacheCleanupRows(overview: CacheOverview | null, mode: "orphans" | "works"): CacheCleanupRow[] {
  if (!overview) return [];
  if (mode === "orphans") {
    return overview.works
      .filter((row) => row.orphanFiles > 0 || row.emptyDirectories > 0)
      .map((row) => ({
        key: row.groupKey,
        workId: row.workId,
        workCode: row.workCode,
        groupKey: `source:${row.sourceCode || row.sourceId || "unknown"}`,
        groupLabel: row.sourceName.trim() || row.sourceCode.trim() || maintenanceCopy("unknownSource"),
        sourceLabel: row.sourceName.trim() || row.sourceCode.trim() || maintenanceCopy("unknownSource"),
        files: row.orphanFiles,
        bytes: row.orphanBytes,
      }));
  }

  const works = new Map<
    number,
    Omit<CacheCleanupRow, "groupKey" | "groupLabel" | "sourceLabel"> & { sources: Map<string, string> }
  >();
  for (const row of overview.works) {
    if (row.workId <= 0 || row.referencedFiles <= 0) continue;
    const current = works.get(row.workId) ?? {
      key: String(row.workId),
      workId: row.workId,
      workCode: row.workCode,
      files: 0,
      bytes: 0,
      sources: new Map<string, string>(),
    };
    current.files += row.referencedFiles;
    current.bytes += row.referencedBytes;
    const sourceKey = row.sourceCode.trim() || String(row.sourceId || "unknown");
    current.sources.set(sourceKey, row.sourceName.trim() || row.sourceCode.trim() || maintenanceCopy("unknownSource"));
    works.set(row.workId, current);
  }
  return Array.from(works.values())
    .sort((left, right) => left.workCode.localeCompare(right.workCode))
    .map(({ sources, ...row }) => {
      const sourceEntries = Array.from(sources.entries());
      const singleSource = sourceEntries.length === 1 ? sourceEntries[0] : null;
      return {
        ...row,
        groupKey: singleSource ? `source:${singleSource[0]}` : "source:multiple",
        groupLabel: singleSource?.[1] ?? maintenanceCopy("multipleSources"),
        sourceLabel: singleSource?.[1] ?? maintenanceCopy("sourcesCount", { count: sourceEntries.length }),
      };
    });
}

function cacheCleanupGroups(rows: CacheCleanupRow[]): CacheCleanupGroup[] {
  const groups = new Map<string, CacheCleanupGroup>();
  for (const row of rows) {
    const group = groups.get(row.groupKey) ?? {
      key: row.groupKey,
      label: row.groupLabel,
      rows: [],
      files: 0,
      bytes: 0,
    };
    group.rows.push(row);
    group.files += row.files;
    group.bytes += row.bytes;
    groups.set(row.groupKey, group);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) => left.workCode.localeCompare(right.workCode)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function CacheMetric({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="min-w-0 rounded-md border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold ${tone === "warning" ? "text-destructive" : ""}`}>
        {value}
      </div>
      <div className="truncate text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function SourceModal({
  source,
  defaultSaveTemplate,
  editing,
  onChange,
  onSave,
  onClose,
}: {
  source: FileSource;
  defaultSaveTemplate: string;
  editing: boolean;
  onChange: (source: FileSource) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const patch = (next: Partial<FileSource>) => onChange({ ...source, ...next });
  const sourceSaveTemplate = source.config.saveRootTemplate?.trim() || defaultSaveTemplate;
  const sourceSavePreview = storagePathPreview(sourceSaveTemplate, source.code.trim() || "source");
  const legacyNumber178 = source.sourceType === LEGACY_NUMBER178_SOURCE_TYPE;
  const configuredOrigins = configuredSourceOrigins(source.endpoint);

  return (
    <Dialog onClose={onClose} size="xl">
      <DialogHeader
        title={editing ? maintenanceCopy("library.editRemoteSource") : maintenanceCopy("library.addRemoteSource")}
        onClose={onClose}
        closeLabel={maintenanceCopy("close")}
      />
      <DialogBody className="space-y-3">
        <TextInput
          label={maintenanceCopy("library.name")}
          value={source.displayName}
          onChange={(value) => patch({ displayName: value })}
        />
        <label className="grid gap-1 text-sm">
          <span className="font-medium">{maintenanceCopy("library.sourceType")}</span>
          <NativeSelect
            fieldSize="sm"
            value={source.sourceType}
            disabled={legacyNumber178}
            onChange={(event) => patch({ sourceType: event.target.value })}
          >
            <option value="kikoeru_compatible">kikoeru_compatible</option>
            {legacyNumber178 && <option value={LEGACY_NUMBER178_SOURCE_TYPE}>{LEGACY_NUMBER178_SOURCE_TYPE}</option>}
          </NativeSelect>
          {legacyNumber178 && (
            <span className="text-xs text-muted-foreground">{maintenanceCopy("library.legacyAdapter")}</span>
          )}
        </label>
        <TextInput
          label={maintenanceCopy("library.publicSiteUrl")}
          value={source.endpoint.baseUrl}
          onChange={(value) => patch({ endpoint: { ...source.endpoint, baseUrl: value } })}
        />
        <TextInput
          label={maintenanceCopy("library.apiUrl")}
          value={source.endpoint.apiUrl}
          onChange={(value) => patch({ endpoint: { ...source.endpoint, apiUrl: value } })}
        />
        <TextInput
          label={maintenanceCopy("library.workUrlTemplate")}
          value={source.endpoint.workUrlTemplate}
          onChange={(value) => patch({ endpoint: { ...source.endpoint, workUrlTemplate: value } })}
        />
        <TextInput
          label={maintenanceCopy("library.fallbackUrl")}
          value={source.endpoint.fallbackUrl}
          onChange={(value) => patch({ endpoint: { ...source.endpoint, fallbackUrl: value } })}
        />
        <div className="grid gap-3 rounded-md border p-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="font-medium">{maintenanceCopy("library.restrictOutboundHosts")}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {maintenanceCopy("library.restrictOutboundDescription")}
              </p>
            </div>
            <Switch
              checked={source.endpoint.restrictOutboundHosts ?? false}
              onCheckedChange={(restrictOutboundHosts) =>
                patch({ endpoint: { ...source.endpoint, restrictOutboundHosts } })
              }
              aria-label={maintenanceCopy("library.restrictOutboundHosts")}
            />
          </div>
          {source.endpoint.restrictOutboundHosts && (
            <div className="grid gap-3 border-t pt-3">
              <div>
                <div className="text-xs font-medium">{maintenanceCopy("library.allowedConfiguredOrigins")}</div>
                {configuredOrigins.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {configuredOrigins.map((origin) => (
                      <Badge key={origin} variant="outline" className="max-w-full break-all font-mono text-2xs">
                        {origin}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">{maintenanceCopy("library.addValidOrigin")}</p>
                )}
              </div>
              <label className="grid gap-1.5">
                <span className="text-xs font-medium">{maintenanceCopy("library.additionalAllowedHosts")}</span>
                <Textarea
                  className="min-h-28 resize-y font-mono text-xs"
                  value={(source.endpoint.allowedHostPatterns ?? []).join("\n")}
                  onChange={(event) =>
                    patch({
                      endpoint: { ...source.endpoint, allowedHostPatterns: event.target.value.split(/\r?\n/u) },
                    })
                  }
                  placeholder={"cdn.example.invalid\n*.media.example.invalid"}
                  aria-label={maintenanceCopy("library.additionalAllowedHosts")}
                />
                <span className="text-xs text-muted-foreground">
                  {maintenanceCopy("library.additionalAllowedDescription")}
                </span>
              </label>
            </div>
          )}
        </div>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{maintenanceCopy("library.priority")}</span>
            <Input
              fieldSize="sm"
              type="number"
              min={1}
              value={source.priority}
              onChange={(event) => patch({ priority: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="grid gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{maintenanceCopy("status.enabled")}</span>
            <Switch
              checked={source.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
              aria-label={maintenanceCopy("library.enableSource")}
            />
          </div>
        </div>
        <div className="rounded-md border bg-muted/20 p-3">
          <ReadonlyField label={maintenanceCopy("library.savePathPreview")} value={sourceSavePreview} />
          <p className="mt-2 text-xs text-muted-foreground">{maintenanceCopy("library.savePathDescription")}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {maintenanceCopy("cancel")}
        </Button>
        <Button size="sm" disabled={!source.displayName.trim()} onClick={() => void onSave()}>
          <Save className="h-4 w-4" />
          {maintenanceCopy("save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function SourceDeleteDialog({
  source,
  deleting,
  onConfirm,
  onClose,
}: {
  source: FileSource;
  deleting: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog onClose={onClose} size="md" dismissible={!deleting}>
      <DialogHeader title={maintenanceCopy("library.deleteRemoteSource")} icon={<Trash2 className="h-4 w-4" />} />
      <DialogBody>
        <div className="rounded-md border bg-muted/25 px-3 py-3">
          <div className="truncate text-sm font-semibold" title={source.displayName}>
            {source.displayName}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{maintenanceCopy("library.deleteSourceDescription")}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={deleting} onClick={onClose}>
          {maintenanceCopy("cancel")}
        </Button>
        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => void onConfirm()}>
          <Trash2 className="h-4 w-4" />
          {deleting ? maintenanceCopy("library.deleting") : maintenanceCopy("library.deleteSource")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function PathsSettings({ settings, remoteSources }: { settings: AppSettings | null; remoteSources: FileSource[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <Server className="h-4 w-4" />
          </span>
          {maintenanceCopy("paths.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{maintenanceCopy("paths.description")}</p>
        <div className="grid gap-3 md:grid-cols-2">
          <ReadonlyField label={maintenanceCopy("paths.localDataRoot")} value={settings?.dataRoot ?? ""} />
          <ReadonlyField label={maintenanceCopy("paths.cacheRoot")} value={settings?.cacheRoot ?? ""} />
          <ReadonlyField
            label={maintenanceCopy("paths.remoteCachePreview")}
            value={storagePathPreview(`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`, "source")}
          />
          <ReadonlyField
            label={maintenanceCopy("paths.remoteSavePreview")}
            value={storagePathPreview(settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`, "source")}
          />
        </div>
        {remoteSources.length > 0 && (
          <section className="border-t pt-4">
            <h3 className="mb-3 text-sm font-semibold">{maintenanceCopy("paths.sourceSavePreviews")}</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {remoteSources.map((source) => (
                <ReadonlyField
                  key={source.id}
                  label={source.displayName}
                  value={storagePathPreview(
                    source.config.saveRootTemplate ||
                      settings?.remoteSaveTemplate ||
                      `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`,
                    source.code || "source",
                  )}
                />
              ))}
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPanel({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border bg-background p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold">{value || maintenanceCopy("unknown")}</div>
      </div>
    </div>
  );
}

function SettingsTabButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      onClick={onClick}
      aria-pressed={active}
    >
      {icon}
      {children}
    </button>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        className="h-9 rounded-md border bg-muted px-3 text-muted-foreground outline-none"
        value={value}
        readOnly
      />
    </label>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input fieldSize="sm" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

type MaintenancePermissions = {
  canManageSources: boolean;
  canManageUsers: boolean;
  canManageAccessPolicy: boolean;
};

function maintenanceTabIsAvailable(tab: MaintenanceTab, permissions: MaintenancePermissions) {
  if (tab === "users") return permissions.canManageUsers || permissions.canManageAccessPolicy;
  return permissions.canManageSources;
}

function maintenanceTabFromLocation(
  canManageSources: boolean,
  canManageUsers: boolean,
  canManageAccessPolicy: boolean,
): MaintenanceTab {
  if (window.location.pathname === "/users" && canManageUsers) return "users";
  const value = new URLSearchParams(window.location.search).get("tab");
  const tabs: MaintenanceTab[] = ["library", "cache", "users"];
  if (
    value &&
    tabs.includes(value as MaintenanceTab) &&
    maintenanceTabIsAvailable(value as MaintenanceTab, {
      canManageSources,
      canManageUsers,
      canManageAccessPolicy,
    })
  )
    return value as MaintenanceTab;
  return canManageSources ? "library" : "users";
}

function storagePathPreview(template: string, sourceCode: string) {
  const workCode = "RJ00000000";
  const normalizedSource = sourceCode.trim() || "source";
  const replacements: Array<[string, string]> = [
    ["<source_name>", normalizedSource],
    ["<source_code>", normalizedSource],
    ["<work_code>", workCode],
    ["<code_prefix>", "RJ"],
    ["<code_group>", "000"],
  ];
  return replacements.reduce(
    (value, [token, replacement]) => value.split(token).join(replacement),
    template.trim() || `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`,
  );
}

function configuredSourceOrigins(endpoint: FileSource["endpoint"]) {
  const origins = new Set<string>();
  [endpoint.apiUrl, endpoint.baseUrl, endpoint.fallbackUrl].forEach((value) => {
    try {
      const parsed = new URL(value.trim());
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) {
        origins.add(parsed.origin);
      }
    } catch {
      // Incomplete endpoint input is validated by the server when saved.
    }
  });
  return [...origins];
}

function languageName(value: string) {
  switch (value) {
    case "ja-jp":
      return "Japanese";
    case "en-us":
      return "English";
    case "zh-cn":
      return "Simplified Chinese";
    case "zh-tw":
      return "Traditional Chinese";
    case "ko-kr":
      return "Korean";
    default:
      return value || "Unknown";
  }
}

function RecommendationTelemetry({ telemetry }: { telemetry: RecommendationTelemetrySummary | null }) {
  const impressions = telemetry?.eventCounts.impression ?? 0;
  const scoreBuckets = ["0-19", "20-39", "40-59", "60-79", "80-100"];
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <Gauge className="h-4 w-4" />
          </span>
          {maintenanceCopy("recommendation.localTelemetry")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatusPanel
            icon={<Sparkles className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.impressions")}
            value={String(impressions)}
          />
          <StatusPanel
            icon={<Folder className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.opened")}
            value={String(telemetry?.eventCounts.open ?? 0)}
          />
          <StatusPanel
            icon={<PlayCircle className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.played")}
            value={String(telemetry?.eventCounts.play ?? 0)}
          />
          <StatusPanel
            icon={<ArrowUp className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.positiveMarks")}
            value={String(telemetry?.eventCounts.positive_mark ?? 0)}
          />
          <StatusPanel
            icon={<ArrowDown className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.shelvedMarks")}
            value={String(telemetry?.eventCounts.paused_mark ?? 0)}
          />
          <StatusPanel
            icon={<RefreshCw className="h-4 w-4" />}
            label={maintenanceCopy("recommendation.reshuffles")}
            value={String(telemetry?.eventCounts.reshuffle ?? 0)}
          />
        </div>
        <div>
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{maintenanceCopy("recommendation.impressionScores")}</span>
            <span className="text-muted-foreground">
              {telemetry
                ? maintenanceCopy("days", { count: telemetry.windowDays })
                : maintenanceCopy("status.unavailable")}
            </span>
          </div>
          <div className="space-y-2">
            {scoreBuckets.map((bucket) => {
              const count = telemetry?.scoreBuckets[bucket] ?? 0;
              const width = impressions > 0 ? Math.max(2, Math.round((count / impressions) * 100)) : 0;
              return (
                <div key={bucket} className="grid grid-cols-[52px_minmax(0,1fr)_40px] items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{bucket}</span>
                  <div className="h-2 overflow-hidden rounded-sm bg-muted">
                    <div className="h-full bg-primary" style={{ width: `${width}%` }} />
                  </div>
                  <span className="text-right tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Cloud,
  Database,
  Download,
  Folder,
  Gauge,
  GripVertical,
  HardDrive,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { UsersPage } from "@/pages/UsersPage";
import {
  api,
  type AppSettings,
  type CacheOverview,
  type DirectoryRoutingRule,
  type FileSource,
  type RecommendationConfig,
  type RecommendationTelemetrySummary,
} from "@/lib/api";

const DATA_PREFIX = "/data";
const DEFAULT_SAVE_SUFFIX = "/<source_name>/<code_prefix>/<code_group>/<work_code>";
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
  config: { cacheEnabled: false, cacheLimitGb: 20 },
  endpoint: { baseUrl: "", apiUrl: "", fallbackUrl: "", workUrlTemplate: "/work/{code}" },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

type MaintenanceTab = "overview" | "routing" | "recommendation" | "library" | "cache" | "metadata" | "users" | "paths";

export function MaintenancePage({
  canManageSources,
  canManageUsers,
  currentUserId,
  isSuperAdmin,
  readOnly = false,
}: {
  canManageSources: boolean;
  canManageUsers: boolean;
  currentUserId: number;
  isSuperAdmin: boolean;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<MaintenanceTab>(() => maintenanceTabFromLocation(canManageUsers));
  const [localScanDepth, setLocalScanDepth] = useState(2);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheLimitGb, setCacheLimitGb] = useState(20);
  const [remoteDelayBase, setRemoteDelayBase] = useState(0.5);
  const [remoteDelayRandom, setRemoteDelayRandom] = useState(1.5);
  const [remoteBackoff, setRemoteBackoff] = useState(30);
  const [remoteMaxBackoff, setRemoteMaxBackoff] = useState(300);
  const [circleAutoRefreshDays, setCircleAutoRefreshDays] = useState(30);
  const [dlsiteMetadataLanguage, setDlsiteMetadataLanguage] = useState("ja-jp");
  const [directoryRoutingRules, setDirectoryRoutingRules] = useState<DirectoryRoutingRule[]>([]);
  const [recommendationThreshold, setRecommendationThreshold] = useState(50);
  const [recommendationConfig, setRecommendationConfig] = useState<RecommendationConfig | null>(null);
  const [recommendationTelemetry, setRecommendationTelemetry] = useState<RecommendationTelemetrySummary | null>(null);
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [checkingSourceId, setCheckingSourceId] = useState<number | null>(null);

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
        setLocalScanDepth(next.localScanDepth);
        setCacheEnabled(next.cacheEnabled);
        setCacheLimitGb(next.cacheLimitGb);
        setRemoteDelayBase(next.remoteDelayBaseSeconds);
        setRemoteDelayRandom(next.remoteDelayRandomSeconds);
        setRemoteBackoff(next.remoteBackoffSeconds);
        setRemoteMaxBackoff(next.remoteMaxBackoffSeconds);
        setCircleAutoRefreshDays(next.circleAutoRefreshDays);
        setDlsiteMetadataLanguage(next.dlsiteMetadataLanguage);
        setDirectoryRoutingRules(reweightDirectoryRoutingRules((next.directoryRoutingRules ?? []).filter((rule) => rule.enabled)));
        setRecommendationThreshold(next.recommendationThreshold ?? 50);
        setRecommendationConfig(next.recommendationConfig);
      })
      .catch((error) => toast.notify(toastFromError(error, "Settings API is unavailable.")))
      .finally(() => setIsSettingsLoading(false));

  useEffect(() => {
    if (!canManageSources) {
      setIsSettingsLoading(false);
      return;
    }
    void reload();
  }, [canManageSources]);

  useEffect(() => {
    if (activeTab !== "recommendation" || !canManageSources) return;
    void api.getRecommendationTelemetry().then(setRecommendationTelemetry).catch(() => setRecommendationTelemetry(null));
  }, [activeTab, canManageSources]);

  useEffect(() => {
    if (activeTab === "users" && !canManageUsers) setActiveTab("overview");
  }, [activeTab, canManageUsers]);

  const selectTab = (tab: MaintenanceTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.pathname = "/maintenance";
    if (tab === "overview") url.searchParams.delete("tab"); else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  };

  const saveRuntimeSettings = async () => {
    if (readOnly) return;
    const next = await api.updateSettings({
      localScanDepth,
      cacheEnabled,
      cacheLimitGb,
      remoteDelayBaseSeconds: remoteDelayBase,
      remoteDelayRandomSeconds: remoteDelayRandom,
      remoteBackoffSeconds: remoteBackoff,
      remoteMaxBackoffSeconds: remoteMaxBackoff,
      circleAutoRefreshDays,
      dlsiteMetadataLanguage,
      directoryRoutingRules,
      recommendationThreshold,
      ...(recommendationConfig ? { recommendationConfig } : {}),
    });
    setSettings(next);
    setCacheEnabled(next.cacheEnabled);
    setRecommendationConfig(next.recommendationConfig);
    toast.success("Settings saved.");
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
    toast.success("Source saved.");
  };

  const deleteSource = async (id: number) => {
    if (readOnly) return;
    await api.deleteFileSource(id);
    await reload();
    toast.success("Source deleted.");
  };

  const checkSourceHealth = async (id: number) => {
    if (readOnly) return;
    setCheckingSourceId(id);
    try {
      const result = await api.checkFileSourceHealth(id);
      setSettings((current) => current ? {
        ...current,
        fileSources: current.fileSources.map((source) => source.id === id ? {
          ...source,
          healthStatus: result.healthStatus,
          lastCheckedAt: result.lastCheckedAt,
        } : source),
      } : current);
      if (result.healthy) toast.success("Source health check passed.");
      else toast.warning("Source health check failed.");
    } catch (error) {
      toast.notify(toastFromError(error, "Source health check could not run."));
    } finally {
      setCheckingSourceId(null);
    }
  };

  if (!canManageSources) {
    return (
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-lg font-semibold">Maintenance</h2>
        <p className="mt-2 text-sm text-muted-foreground">Instance maintenance requires administrator access.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-4">
        <p className="text-sm font-medium text-muted-foreground">Instance administration</p>
        <h2 className="mt-1 text-2xl font-semibold">Maintenance</h2>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Configure library sources, routing, caching, metadata, users, and resolved runtime paths.</p>
      </section>

      {readOnly && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-muted-foreground" role="status">
          Demo mode is read-only. Settings and sources remain visible but cannot be changed.
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
        <SettingsTabButton active={activeTab === "overview"} onClick={() => selectTab("overview")} icon={<SlidersHorizontal className="h-4 w-4" />}>
          Overview
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "routing"} onClick={() => selectTab("routing")} icon={<PlayCircle className="h-4 w-4" />}>
          Routing
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "recommendation"} onClick={() => selectTab("recommendation")} icon={<Sparkles className="h-4 w-4" />}>
          Recommendation
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "library"} onClick={() => selectTab("library")} icon={<Folder className="h-4 w-4" />}>
          Library
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "cache"} onClick={() => selectTab("cache")} icon={<Download className="h-4 w-4" />}>
          Cache & Fetch
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "metadata"} onClick={() => selectTab("metadata")} icon={<RefreshCw className="h-4 w-4" />}>
          Metadata
        </SettingsTabButton>
        {canManageUsers && <SettingsTabButton active={activeTab === "users"} onClick={() => selectTab("users")} icon={<Shield className="h-4 w-4" />}>
          Users
        </SettingsTabButton>}
        <SettingsTabButton active={activeTab === "paths"} onClick={() => selectTab("paths")} icon={<Server className="h-4 w-4" />}>
          Paths
        </SettingsTabButton>
      </div>

      <fieldset disabled={readOnly} className="min-w-0 border-0 p-0">
      {isSettingsLoading ? (
        activeTab === "overview" ? (
          <SettingsOverviewSkeleton />
        ) : activeTab === "library" ? (
          <RemoteSourcesSettingsSkeleton />
        ) : (
          <SettingsPanelSkeleton />
        )
      ) : activeTab === "overview" ? (
        <SettingsOverview
          remoteSources={remoteSources}
          localSource={localSource}
          cacheEnabled={cacheEnabled}
          cacheLimitGb={cacheLimitGb}
          localScanDepth={localScanDepth}
          circleAutoRefreshDays={circleAutoRefreshDays}
          onSelect={selectTab}
          canManageUsers={canManageUsers}
        />
      ) : activeTab === "routing" ? (
        <PlaybackSettings
          rules={directoryRoutingRules}
          onRulesChange={setDirectoryRoutingRules}
          onSave={saveRuntimeSettings}
        />
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
            onDeleteSource={deleteSource}
            onCheckSource={checkSourceHealth}
          />
        </div>
      ) : activeTab === "recommendation" ? (
        <RecommendationSettings
          config={recommendationConfig}
          defaults={settings?.recommendationDefaults ?? null}
          threshold={recommendationThreshold}
          telemetry={recommendationTelemetry}
          onConfigChange={setRecommendationConfig}
          onThresholdChange={setRecommendationThreshold}
          onSave={saveRuntimeSettings}
        />
      ) : activeTab === "cache" ? (
        <CacheFetchSettings
          cacheEnabled={cacheEnabled}
          cacheLimitGb={cacheLimitGb}
          remoteDelayBase={remoteDelayBase}
          remoteDelayRandom={remoteDelayRandom}
          remoteBackoff={remoteBackoff}
          remoteMaxBackoff={remoteMaxBackoff}
          onCacheEnabledChange={setCacheEnabled}
          onCacheLimitChange={setCacheLimitGb}
          onRemoteDelayBaseChange={setRemoteDelayBase}
          onRemoteDelayRandomChange={setRemoteDelayRandom}
          onRemoteBackoffChange={setRemoteBackoff}
          onRemoteMaxBackoffChange={setRemoteMaxBackoff}
          onSave={saveRuntimeSettings}
        />
      ) : activeTab === "metadata" ? (
        <MetadataSettings
          circleAutoRefreshDays={circleAutoRefreshDays}
          dlsiteMetadataLanguage={dlsiteMetadataLanguage}
          onCircleAutoRefreshDaysChange={setCircleAutoRefreshDays}
          onDlsiteMetadataLanguageChange={setDlsiteMetadataLanguage}
          onSave={saveRuntimeSettings}
        />
      ) : activeTab === "users" ? (
        <UsersPage currentUserId={currentUserId} isSuperAdmin={isSuperAdmin} embedded />
      ) : (
        <PathsSettings settings={settings} remoteSources={remoteSources} />
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
    </div>
  );
}

function SettingsOverview({
  remoteSources,
  localSource,
  cacheEnabled,
  cacheLimitGb,
  localScanDepth,
  circleAutoRefreshDays,
  onSelect,
  canManageUsers,
}: {
  remoteSources: FileSource[];
  localSource: FileSource | null;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  localScanDepth: number;
  circleAutoRefreshDays: number;
  onSelect: (tab: MaintenanceTab) => void;
  canManageUsers: boolean;
}) {
  const enabledSources = remoteSources.filter((source) => source.enabled).length;
  const warningSources = remoteSources.filter((source) => ["error", "unavailable", "disabled"].includes(source.healthStatus)).length;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <SettingsHomeCard
        icon={<PlayCircle className="h-5 w-5" />}
        title="Directory routing"
        description="Order directory preferences for playback and Fetch actions."
        status="Configured"
        chips={["Ordered", "Aliases", "Fallback"]}
        onClick={() => onSelect("routing")}
      />
      <SettingsHomeCard
        icon={<Folder className="h-5 w-5" />}
        title="Library"
        description="Local source scan behavior and library root visibility."
        status={localSource?.enabled ? "Active" : "Needs scan"}
        chips={[localSource?.displayName ?? "Main local library", `${localScanDepth} scan levels`]}
        onClick={() => onSelect("library")}
      />
      <SettingsHomeCard
        icon={<Cloud className="h-5 w-5" />}
        title="Remote sources"
        description="Manage configured file sources, health, and priority."
        status={`${enabledSources}/${remoteSources.length} enabled`}
        chips={[warningSources > 0 ? `${warningSources} warnings` : "Healthy", "Priority", "Endpoints"]}
        onClick={() => onSelect("library")}
      />
      <SettingsHomeCard
        icon={<Download className="h-5 w-5" />}
        title="Cache & fetch"
        description="Remote playback cache and request pacing."
        status={cacheEnabled ? "Auto cache on" : "Auto cache off"}
        chips={[`${cacheLimitGb} GB limit`, "Request pacing"]}
        onClick={() => onSelect("cache")}
      />
      <SettingsHomeCard
        icon={<RefreshCw className="h-5 w-5" />}
        title="Metadata"
        description="DLsite localization and circle refresh behavior."
        status={circleAutoRefreshDays === 0 ? "Manual refresh" : `${circleAutoRefreshDays} day refresh`}
        chips={["DLsite", "Circles", "Language"]}
        onClick={() => onSelect("metadata")}
      />
      <SettingsHomeCard
        icon={<Server className="h-5 w-5" />}
        title="Paths"
        description="Read-only runtime roots and resolved storage templates."
        status="Read only"
        chips={["/data", "/cache", "Docker"]}
        onClick={() => onSelect("paths")}
      />
      {canManageUsers && <SettingsHomeCard
        icon={<Shield className="h-5 w-5" />}
        title="Users"
        description="Create accounts and manage instance access."
        status="Admin"
        chips={["Accounts", "Roles", "Access"]}
        onClick={() => onSelect("users")}
      />}
    </div>
  );
}

function SettingsHomeCard({
  icon,
  title,
  description,
  status,
  chips,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status: string;
  chips: string[];
  onClick: () => void;
}) {
  return (
    <button
      className="group flex min-h-[188px] flex-col justify-between rounded-lg border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/45 hover:bg-muted/35"
      onClick={onClick}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
        <Badge variant="outline" className="max-w-[140px] truncate">{status}</Badge>
      </span>
      <span className="mt-5 block">
        <span className="block text-base font-semibold">{title}</span>
        <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{description}</span>
      </span>
      <span className="mt-4 flex flex-wrap gap-1.5">
        {chips.slice(0, 3).map((chip) => (
          <Badge key={chip} variant="secondary" className="max-w-full truncate">{chip}</Badge>
        ))}
      </span>
    </button>
  );
}

function PlaybackSettings({
  rules,
  onRulesChange,
  onSave,
}: {
  rules: DirectoryRoutingRule[];
  onRulesChange: (rules: DirectoryRoutingRule[]) => void;
  onSave: () => Promise<void>;
}) {
  const [draggedRuleId, setDraggedRuleId] = useState<string | null>(null);
  const draggedRuleIdRef = useRef<string | null>(null);
  const applyRules = (next: DirectoryRoutingRule[]) => onRulesChange(reweightDirectoryRoutingRules(next));
  const patchRule = (index: number, patch: Partial<DirectoryRoutingRule>) => {
    onRulesChange(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch, enabled: true } : rule));
  };
  const moveRuleTo = (index: number, nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= rules.length) return;
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(nextIndex, 0, rule);
    applyRules(next);
  };
  const moveRule = (index: number, direction: -1 | 1) => moveRuleTo(index, index + direction);
  const addRule = () => {
    applyRules([
      ...rules,
      {
        id: `rule_${Date.now()}`,
        label: "New rule",
        weight: 20,
        aliases: ["keyword"],
        negativeAliases: [],
        enabled: true,
      },
    ]);
  };
  const removeRule = (index: number) => applyRules(rules.filter((_, ruleIndex) => ruleIndex !== index));
  const finishDrag = () => {
    draggedRuleIdRef.current = null;
    setDraggedRuleId(null);
  };

  useEffect(() => {
    if (draggedRuleId === null) return;
    const finish = () => {
      draggedRuleIdRef.current = null;
      setDraggedRuleId(null);
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [draggedRuleId]);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                <PlayCircle className="h-4 w-4" />
              </span>
              <span className="truncate">Playback</span>
            </span>
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus className="h-4 w-4" />
              Add rule
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative space-y-2 before:absolute before:bottom-5 before:left-5 before:top-5 before:w-px before:bg-border">
            {rules.map((rule, index) => (
              <DirectoryRuleEditor
                key={rule.id || index}
                rule={rule}
                index={index}
                canMoveUp={index > 0}
                canMoveDown={index < rules.length - 1}
                onPatch={(patch) => patchRule(index, patch)}
                onMove={moveRule}
                onDragStart={() => {
                  draggedRuleIdRef.current = rule.id;
                  setDraggedRuleId(rule.id);
                }}
                onDragMove={(clientX, clientY) => {
                  const sourceId = draggedRuleIdRef.current;
                  const source = rules.findIndex((candidate) => candidate.id === sourceId);
                  const target = Number(document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-routing-rule-index]")?.dataset.routingRuleIndex);
                  if (source >= 0 && Number.isInteger(target) && source !== target) {
                    moveRuleTo(source, target);
                  }
                }}
                onDragEnd={finishDrag}
                dragging={draggedRuleId === rule.id}
                onRemove={() => removeRule(index)}
              />
            ))}
            {rules.length === 0 && (
              <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                Add at least one rule to prefer matching playable folders.
              </div>
            )}
          </div>
          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            Save playback settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function DirectoryRuleEditor({
  rule,
  index,
  canMoveUp,
  canMoveDown,
  onPatch,
  onMove,
  onDragStart,
  onDragMove,
  onDragEnd,
  dragging,
  onRemove,
}: {
  rule: DirectoryRoutingRule;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPatch: (patch: Partial<DirectoryRoutingRule>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDragStart: () => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
  dragging: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      data-routing-rule-index={index}
      data-routing-rule-id={rule.id}
      className={`relative flex min-w-0 gap-3 ${dragging ? "opacity-55" : ""}`}
    >
      <div className="relative z-[1] flex w-10 shrink-0 flex-col items-center gap-1.5">
        <button
          type="button"
          className="grid h-8 w-8 touch-none cursor-grab place-items-center rounded-md border bg-card text-muted-foreground active:cursor-grabbing"
          aria-label={`Drag ${rule.label}`}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onDragStart();
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) onDragMove(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            onDragEnd();
          }}
          onPointerCancel={onDragEnd}
          onLostPointerCapture={onDragEnd}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">{index + 1}</span>
      </div>
      <details className="group min-w-0 flex-1 rounded-md border bg-background">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 marker:hidden">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{rule.label}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {rule.aliases.length} match keyword{rule.aliases.length === 1 ? "" : "s"}
              {rule.negativeAliases.length > 0 ? ` · ${rule.negativeAliases.length} exclusion${rule.negativeAliases.length === 1 ? "" : "s"}` : ""}
            </div>
          </div>
          <span className="text-xs text-muted-foreground group-open:hidden">Edit</span>
          <span className="hidden text-xs text-muted-foreground group-open:inline">Close</span>
        </summary>
        <div className="space-y-3 border-t p-3">
          <TextInput label="Rule name" value={rule.label} onChange={(value) => onPatch({ label: value })} />
          <div className="grid gap-3 md:grid-cols-2">
            <TagListInput label="Aliases" value={rule.aliases} onChange={(aliases) => onPatch({ aliases })} />
            <TagListInput label="Negative aliases" value={rule.negativeAliases} onChange={(negativeAliases) => onPatch({ negativeAliases })} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 border-t pt-3">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={!canMoveUp} onClick={() => onMove(index, -1)}>
                <ArrowUp className="h-4 w-4" />
                Earlier
              </Button>
              <Button variant="outline" size="sm" disabled={!canMoveDown} onClick={() => onMove(index, 1)}>
                <ArrowDown className="h-4 w-4" />
                Later
              </Button>
            </div>
            <Button variant="outline" size="sm" className="text-destructive" onClick={onRemove}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

function reweightDirectoryRoutingRules(rules: DirectoryRoutingRule[]) {
  if (rules.length === 0) return [];
  const step = rules.length === 1 ? 0 : Math.min(10, Math.max(1, Math.floor(80 / (rules.length - 1))));
  const firstWeight = rules.length === 1 ? 40 : 20 + step * (rules.length - 1);
  return rules.map((rule, index) => ({ ...rule, weight: firstWeight - step * index, enabled: true }));
}

function TagListInput({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string[]) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        className="min-h-20 rounded-md border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
        value={value.join(", ")}
        onChange={(event) => onChange(splitRuleTokens(event.target.value))}
      />
      <span className="text-xs text-muted-foreground">Separate words with commas or new lines.</span>
    </label>
  );
}

function SettingsSkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function SettingsOverviewSkeleton() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex min-h-[188px] flex-col justify-between rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <SettingsSkeletonLine className="h-10 w-10 rounded-md" />
            <SettingsSkeletonLine className="h-5 w-24 rounded-full" />
          </div>
          <div className="mt-5 space-y-2">
            <SettingsSkeletonLine className="h-5 w-36" />
            <SettingsSkeletonLine className="h-3 w-full" />
            <SettingsSkeletonLine className="h-3 w-4/5" />
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            <SettingsSkeletonLine className="h-6 w-16 rounded-full" />
            <SettingsSkeletonLine className="h-6 w-20 rounded-full" />
            <SettingsSkeletonLine className="h-6 w-14 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
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
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <SettingsSkeletonLine className="h-5 w-36" />
            <SettingsSkeletonLine className="h-4 w-72 max-w-full" />
          </div>
          <SettingsSkeletonLine className="h-9 w-28 rounded-md" />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex items-center gap-3 rounded-lg border bg-background p-3">
              <SettingsSkeletonLine className="h-9 w-9 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <SettingsSkeletonLine className="h-3 w-20" />
                <SettingsSkeletonLine className="h-4 w-16" />
              </div>
            </div>
          ))}
        </div>
      </section>
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <SettingsSkeletonLine className="h-8 w-8 rounded-md" />
                  <SettingsSkeletonLine className="h-5 w-40" />
                </span>
                <SettingsSkeletonLine className="h-5 w-16 rounded-full" />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <SettingsSkeletonLine className="h-14 w-full" />
                <SettingsSkeletonLine className="h-14 w-full" />
                <SettingsSkeletonLine className="h-14 w-full" />
              </div>
              <SettingsSkeletonLine className="h-14 w-full" />
              <div className="flex gap-2">
                <SettingsSkeletonLine className="h-9 flex-1 rounded-md" />
                <SettingsSkeletonLine className="h-9 w-9 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function MetadataSettings({
  circleAutoRefreshDays,
  dlsiteMetadataLanguage,
  onCircleAutoRefreshDaysChange,
  onDlsiteMetadataLanguageChange,
  onSave,
}: {
  circleAutoRefreshDays: number;
  dlsiteMetadataLanguage: string;
  onCircleAutoRefreshDaysChange: (value: number) => void;
  onDlsiteMetadataLanguageChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <RefreshCw className="h-4 w-4" />
          </span>
          Metadata
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">DLsite title/tag language</span>
            <select
              className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
              value={dlsiteMetadataLanguage}
              onChange={(event) => onDlsiteMetadataLanguageChange(event.target.value)}
            >
              <option value="ja-jp">Japanese</option>
              <option value="en-us">English</option>
              <option value="zh-cn">Simplified Chinese</option>
              <option value="zh-tw">Traditional Chinese</option>
              <option value="ko-kr">Korean</option>
            </select>
          </label>
          <div className="self-end rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            DLsite metadata sync uses this language first, then falls back to Japanese when the localized product data is unavailable.
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Auto refresh days</span>
            <input
              className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
              type="number"
              min={0}
              max={365}
              value={circleAutoRefreshDays}
              onChange={(event) => onCircleAutoRefreshDaysChange(Number(event.target.value))}
            />
          </label>
          <div className="self-end rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
            {circleAutoRefreshDays === 0
              ? "Automatic circle refresh on detail entry is disabled."
              : `Circle detail pages may refresh when local metadata is older than ${circleAutoRefreshDays} days.`}
          </div>
        </div>
        <Button size="sm" onClick={() => void onSave()}>
          <Save className="h-4 w-4" />
          Save metadata settings
        </Button>
      </CardContent>
    </Card>
  );
}

type RecommendationConfigKey = keyof RecommendationConfig;

const recommendationStateFields: Array<{ key: RecommendationConfigKey; label: string }> = [
  { key: "nonePrior", label: "Unmarked" },
  { key: "wantPrior", label: "Want" },
  { key: "listeningPrior", label: "Listening" },
  { key: "finishedPrior", label: "Finished" },
  { key: "relistenPrior", label: "Relisten" },
  { key: "pausedPrior", label: "Shelved" },
];

const recommendationPositiveFields: Array<{ key: RecommendationConfigKey; label: string; max: number }> = [
  { key: "tagWeight", label: "Positive tag weight", max: 50 },
  { key: "tagCap", label: "Positive tag cap", max: 100 },
  { key: "voiceWeight", label: "Positive voice weight", max: 50 },
  { key: "voiceCap", label: "Positive voice cap", max: 100 },
  { key: "circleWeight", label: "Positive circle weight", max: 50 },
  { key: "circleCap", label: "Positive circle cap", max: 100 },
  { key: "favoriteBonus", label: "Favorite bonus", max: 50 },
];

const recommendationNegativeFields: Array<{ key: RecommendationConfigKey; label: string; min?: number; max: number }> = [
  { key: "negativeMinEvidence", label: "Shelved evidence works", min: 1, max: 10 },
  { key: "negativeTagWeight", label: "Shelved tag weight", max: 50 },
  { key: "negativeTagCap", label: "Shelved tag cap", max: 100 },
  { key: "negativeVoiceWeight", label: "Shelved voice weight", max: 50 },
  { key: "negativeVoiceCap", label: "Shelved voice cap", max: 100 },
  { key: "negativeCircleWeight", label: "Shelved circle weight", max: 50 },
  { key: "negativeCircleCap", label: "Shelved circle cap", max: 100 },
  { key: "negativeTotalCap", label: "Shelved total cap", max: 100 },
];

type RecommendationPreset = "balanced" | "familiar" | "exploratory" | "avoid_shelved";

const recommendationPresetOptions: Array<{ key: RecommendationPreset; label: string; description: string }> = [
  { key: "balanced", label: "Balanced", description: "Default affinity and variety" },
  { key: "familiar", label: "Familiar", description: "Stronger tag, voice, and circle affinity" },
  { key: "exploratory", label: "Exploratory", description: "More unmarked works and ordering variety" },
  { key: "avoid_shelved", label: "Avoid shelved", description: "Stronger penalty for repeated shelved similarity" },
];

function RecommendationSettings({
  config,
  defaults,
  threshold,
  telemetry,
  onConfigChange,
  onThresholdChange,
  onSave,
}: {
  config: RecommendationConfig | null;
  defaults: RecommendationConfig | null;
  threshold: number;
  telemetry: RecommendationTelemetrySummary | null;
  onConfigChange: (value: RecommendationConfig) => void;
  onThresholdChange: (value: number) => void;
  onSave: () => Promise<void>;
}) {
  if (!config) return <SettingsPanelSkeleton />;

  const updateField = (key: RecommendationConfigKey, value: number) => {
    onConfigChange({ ...config, [key]: value });
  };
  const impressions = telemetry?.eventCounts.impression ?? 0;
  const scoreBuckets = ["0-19", "20-39", "40-59", "60-79", "80-100"];
  const activePreset = defaults
    ? recommendationPresetOptions.find((preset) => recommendationConfigsEqual(config, recommendationPresetConfig(defaults, preset.key)))?.key ?? "custom"
    : "custom";
  const exampleScore = Math.max(0, Math.min(100,
    config.nonePrior
    + Math.min(config.tagCap, config.tagWeight)
    + Math.min(config.voiceCap, config.voiceWeight)
    + Math.min(config.circleCap, config.circleWeight),
  ));

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
                <Sparkles className="h-4 w-4" />
              </span>
              Recommendation tuning
            </span>
            <Button type="button" variant="outline" size="sm" disabled={!defaults} onClick={() => {
              if (!defaults) return;
              onConfigChange({ ...defaults });
              onThresholdChange(50);
            }}>
              <RotateCcw className="h-4 w-4" />
              Restore defaults
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Recommendation profile</h3>
              {activePreset === "custom" && <Badge variant="outline">Custom</Badge>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {recommendationPresetOptions.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`min-h-16 rounded-md border px-3 py-2 text-left transition-colors ${activePreset === preset.key ? "border-primary bg-primary/8" : "bg-background hover:bg-muted/40"}`}
                  aria-pressed={activePreset === preset.key}
                  disabled={!defaults}
                  onClick={() => defaults && onConfigChange(recommendationPresetConfig(defaults, preset.key))}
                >
                  <span className="block text-sm font-semibold">{preset.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{preset.description}</span>
                </button>
              ))}
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_220px]">
            <RecommendationRangeField label="Badge threshold" value={threshold} min={1} max={100} onChange={onThresholdChange} />
            <RecommendationRangeField label="Result variation" value={config.jitterAmplitude} min={0} max={10} onChange={(value) => updateField("jitterAmplitude", value)} />
            <div className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2">
              <div>
                <div className="text-xs text-muted-foreground">Example score</div>
                <div className="text-2xl font-semibold tabular-nums">{exampleScore}</div>
              </div>
              <Badge variant={exampleScore >= threshold ? "secondary" : "outline"}>{exampleScore >= threshold ? "Badge shown" : "Below threshold"}</Badge>
            </div>
          </div>

          <details className="rounded-md border bg-background">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Advanced scoring</summary>
            <div className="space-y-5 border-t p-4">
              <RecommendationFieldGroup title="Listening state base score">
                {recommendationStateFields.map((field) => (
                  <RecommendationNumberField key={field.key} label={field.label} value={config[field.key]} defaultValue={defaults?.[field.key]} min={-100} max={100} onChange={(value) => updateField(field.key, value)} />
                ))}
              </RecommendationFieldGroup>

              <RecommendationFieldGroup title="Positive affinity per match and cap">
                {recommendationPositiveFields.map((field) => (
                  <RecommendationNumberField key={field.key} label={field.label} value={config[field.key]} defaultValue={defaults?.[field.key]} min={0} max={field.max} onChange={(value) => updateField(field.key, value)} />
                ))}
              </RecommendationFieldGroup>

              <RecommendationFieldGroup title="Shelved similarity penalty">
                {recommendationNegativeFields.map((field) => (
                  <RecommendationNumberField key={field.key} label={field.label} value={config[field.key]} defaultValue={defaults?.[field.key]} min={field.min ?? 0} max={field.max} onChange={(value) => updateField(field.key, value)} />
                ))}
              </RecommendationFieldGroup>
            </div>
          </details>

          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            Save recommendation settings
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Gauge className="h-4 w-4" />
            </span>
            Local telemetry
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatusPanel icon={<Sparkles className="h-4 w-4" />} label="Impressions" value={String(impressions)} />
            <StatusPanel icon={<Folder className="h-4 w-4" />} label="Opened" value={String(telemetry?.eventCounts.open ?? 0)} />
            <StatusPanel icon={<PlayCircle className="h-4 w-4" />} label="Played" value={String(telemetry?.eventCounts.play ?? 0)} />
            <StatusPanel icon={<ArrowUp className="h-4 w-4" />} label="Positive marks" value={String(telemetry?.eventCounts.positive_mark ?? 0)} />
            <StatusPanel icon={<ArrowDown className="h-4 w-4" />} label="Shelved marks" value={String(telemetry?.eventCounts.paused_mark ?? 0)} />
            <StatusPanel icon={<RefreshCw className="h-4 w-4" />} label="Reshuffles" value={String(telemetry?.eventCounts.reshuffle ?? 0)} />
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">Impression scores</span>
              <span className="text-muted-foreground">{telemetry ? `${telemetry.windowDays} days` : "Unavailable"}</span>
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
    </div>
  );
}

function RecommendationFieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
    </section>
  );
}

function RecommendationNumberField({
  label,
  value,
  defaultValue,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  defaultValue?: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="flex items-center justify-between gap-2 font-medium">
        <span>{label}</span>
        {defaultValue !== undefined && value !== defaultValue && <span className="text-[10px] font-normal text-muted-foreground">Default {defaultValue}</span>}
      </span>
      <input
        className="h-9 min-w-0 rounded-md border bg-card px-3 tabular-nums outline-none focus:ring-2 focus:ring-ring"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function RecommendationRangeField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <label className="grid gap-2 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="flex items-center justify-between gap-3 font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function recommendationPresetConfig(defaults: RecommendationConfig, preset: RecommendationPreset): RecommendationConfig {
  switch (preset) {
  case "familiar":
    return { ...defaults, tagWeight: 7, tagCap: 35, voiceWeight: 13, voiceCap: 30, circleWeight: 20, circleCap: 25, jitterAmplitude: 1 };
  case "exploratory":
    return { ...defaults, nonePrior: 45, tagWeight: 3, tagCap: 15, voiceWeight: 6, voiceCap: 15, circleWeight: 8, circleCap: 10, jitterAmplitude: 8 };
  case "avoid_shelved":
    return { ...defaults, pausedPrior: -70, negativeTagWeight: 4, negativeTagCap: 10, negativeVoiceWeight: 5, negativeVoiceCap: 10, negativeCircleWeight: 8, negativeCircleCap: 10, negativeTotalCap: 25 };
  default:
    return { ...defaults };
  }
}

function recommendationConfigsEqual(left: RecommendationConfig, right: RecommendationConfig) {
  return (Object.keys(left) as RecommendationConfigKey[]).every((key) => left[key] === right[key]);
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
            Local library
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Scan depth</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={1}
                max={8}
                value={localScanDepth}
                onChange={(event) => onScanDepthChange(Number(event.target.value))}
              />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <Badge variant="secondary">{localSource?.displayName ?? "Main local library"}</Badge>
              <Badge variant="outline">{localSource?.enabled ? "enabled" : "not scanned"}</Badge>
            </div>
          </div>
          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            Save local settings
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
  onDeleteSource: (id: number) => Promise<void>;
  onCheckSource: (id: number) => Promise<void>;
}) {
  const enabledSources = remoteSources.filter((source) => source.enabled).length;
  const attentionSources = remoteSources.filter(
    (source) => source.enabled && ["error", "unavailable"].includes(source.healthStatus),
  ).length;
  return (
    <div className="space-y-4">
      <section id="remote-sources" className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Remote sources</h2>
            <p className="text-sm text-muted-foreground">Configure source endpoints without making them separate work libraries.</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreateSource}>
            <Plus className="h-4 w-4" />
            Add source
          </Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <StatusPanel icon={<Cloud className="h-4 w-4" />} label="Configured" value={String(remoteSources.length)} />
          <StatusPanel icon={<Shield className="h-4 w-4" />} label="Enabled" value={String(enabledSources)} />
          <StatusPanel icon={<RefreshCw className="h-4 w-4" />} label="Needs attention" value={String(attentionSources)} />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        {remoteSources.map((source) => (
          <Card key={source.id} className="overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <Database className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 truncate">{source.displayName}</span>
                </span>
                <Badge variant={source.enabled ? "outline" : "warning"}>{source.enabled ? "enabled" : "disabled"}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <SourceFact label="Health" value={source.healthStatus} />
                <SourceFact label="Priority" value={String(source.priority)} />
                <SourceFact label="Cache" value={source.config.cacheEnabled ? "On" : "Off"} />
              </div>
              <div className="rounded-md border bg-background px-3 py-2">
                <div className="text-xs font-medium text-muted-foreground">Endpoint</div>
                <div className="mt-1 truncate text-sm">{source.endpoint.baseUrl || source.endpoint.apiUrl || "No endpoint configured"}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void onCheckSource(source.id)} disabled={!source.enabled || checkingSourceId !== null}>
                  <RefreshCw className={`h-4 w-4 ${checkingSourceId === source.id ? "animate-spin" : ""}`} />
                  {checkingSourceId === source.id ? "Checking" : "Check health"}
                </Button>
                <Button variant="outline" size="sm" className="flex-1" onClick={() => onEditSource(source)}>
                  Configure
                </Button>
                <Button variant="outline" size="icon" aria-label="Delete source" onClick={() => void onDeleteSource(source.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {remoteSources.length === 0 && (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">No remote sources configured yet.</CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function CacheFetchSettings({
  cacheEnabled,
  cacheLimitGb,
  remoteDelayBase,
  remoteDelayRandom,
  remoteBackoff,
  remoteMaxBackoff,
  onCacheEnabledChange,
  onCacheLimitChange,
  onRemoteDelayBaseChange,
  onRemoteDelayRandomChange,
  onRemoteBackoffChange,
  onRemoteMaxBackoffChange,
  onSave,
}: {
  cacheEnabled: boolean;
  cacheLimitGb: number;
  remoteDelayBase: number;
  remoteDelayRandom: number;
  remoteBackoff: number;
  remoteMaxBackoff: number;
  onCacheEnabledChange: (value: boolean) => void;
  onCacheLimitChange: (value: number) => void;
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
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
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
        if (checked) next.add(row.key); else next.delete(row.key);
      }
      return next;
    });
    setConfirmCleanup(false);
  };

  const toggleCleanupGroup = (groupKey: string) => {
    setExpandedCleanupGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
      return next;
    });
    setCleanupGroupLimits((current) => current.has(groupKey) ? current : new Map(current).set(groupKey, CACHE_GROUP_PAGE_SIZE));
  };

  const showMoreCleanupRows = (groupKey: string) => {
    setCleanupGroupLimits((current) => new Map(current).set(groupKey, (current.get(groupKey) ?? CACHE_GROUP_PAGE_SIZE) + CACHE_GROUP_PAGE_SIZE));
  };

  const scanCache = async () => {
    setIsScanning(true);
    try {
      setOverview(await api.getCacheOverview());
      setSelectedCleanupKeys(new Set());
      setConfirmCleanup(false);
    } catch (error) {
      toast.notify(toastFromError(error, "Cache scan failed."));
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    void scanCache();
  }, []);

  const cleanupCache = async () => {
    if (!confirmCleanup) {
      setConfirmCleanup(true);
      return;
    }
    setIsCleaning(true);
    try {
      const result = cleanupMode === "orphans"
        ? await api.cleanupCache({ mode: "orphans", groupKeys: selectedCleanupRows.map((row) => row.key) })
        : await api.cleanupCache({ mode: "works", workIds: selectedCleanupRows.map((row) => row.workId) });
      setConfirmCleanup(false);
      setSelectedCleanupKeys(new Set());
      setCleanupStatus(
        result.status === "succeeded"
          ? "No eligible orphan files remain."
          : `Cleanup queued in workflow run #${result.runId} (${result.queued} items).`,
      );
      toast.success(result.status === "succeeded" ? "Cache is already clean." : "Cache cleanup queued.");
      await scanCache();
    } catch (error) {
      toast.notify(toastFromError(error, "Cache cleanup failed."));
    } finally {
      setIsCleaning(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="max-w-3xl overflow-hidden" data-testid="cache-configuration-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Settings2 className="h-4 w-4" />
            </span>
            Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-hidden rounded-md border">
            <ConfigurationSectionLabel>Cache policy</ConfigurationSectionLabel>
            <ConfigurationRow
              title="Cache remote playback"
              description="Keep remotely played media on local storage for later playback."
            >
              <Switch checked={cacheEnabled} onCheckedChange={onCacheEnabledChange} aria-label="Cache remote playback" />
            </ConfigurationRow>
            <ConfigurationRow
              title="Cache limit"
              description="Maximum total size of the managed playback cache."
            >
              <div className="flex h-9 w-full overflow-hidden rounded-md border bg-card sm:w-44">
                <input
                  aria-label="Cache limit"
                  className="min-w-0 flex-1 bg-transparent px-3 text-right outline-none focus:ring-2 focus:ring-ring"
                  type="number"
                  min={0}
                  value={cacheLimitGb}
                  onChange={(event) => onCacheLimitChange(Number(event.target.value))}
                />
                <span className="flex items-center border-l bg-muted px-3 text-xs text-muted-foreground">GB</span>
              </div>
            </ConfigurationRow>

            <ConfigurationSectionLabel>Remote request pacing</ConfigurationSectionLabel>
            <ConfigurationRow
              title="Base delay"
              description="Minimum pause between requests to a remote source."
            >
              <ConfigurationNumberInput
                label="Base delay"
                value={remoteDelayBase}
                min={0}
                step={0.1}
                onChange={onRemoteDelayBaseChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title="Random delay"
              description="Additional jitter used to avoid synchronized request bursts."
            >
              <ConfigurationNumberInput
                label="Random delay"
                value={remoteDelayRandom}
                min={0}
                step={0.1}
                onChange={onRemoteDelayRandomChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title="Initial 429 backoff"
              description="First retry delay after a remote rate-limit response."
            >
              <ConfigurationNumberInput
                label="Initial 429 backoff"
                value={remoteBackoff}
                min={0}
                step={1}
                onChange={onRemoteBackoffChange}
              />
            </ConfigurationRow>
            <ConfigurationRow
              title="Maximum backoff"
              description="Upper bound for repeated rate-limit retries."
            >
              <ConfigurationNumberInput
                label="Maximum backoff"
                value={remoteMaxBackoff}
                min={0}
                step={1}
                onChange={onRemoteMaxBackoffChange}
              />
            </ConfigurationRow>
          </div>

          <Button size="sm" onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            Save configuration
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4" />
            Managed media cache
          </CardTitle>
          <Button variant="outline" size="icon" onClick={() => void scanCache()} disabled={isScanning} aria-label="Refresh cache overview" title="Refresh cache overview">
            <RefreshCw className={`h-4 w-4 ${isScanning ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <CacheMetric label="On disk" value={overview ? formatByteSize(overview.mediaBytes) : "--"} detail={overview ? `${overview.mediaFiles} files` : "Scanning"} />
            <CacheMetric label="Referenced" value={overview ? formatByteSize(overview.referencedBytes) : "--"} detail={overview ? `${overview.referencedFiles} files` : "Scanning"} />
            <CacheMetric label="Eligible cleanup" value={overview ? formatByteSize(overview.orphanBytes) : "--"} detail={overview ? `${overview.orphanFiles} files` : "Scanning"} tone={overview?.orphanFiles ? "warning" : "default"} />
            <CacheMetric label="Protected" value={overview ? String(overview.protectedFiles) : "--"} detail="Files newer than 24 hours" />
          </div>

          {overview && (overview.missingReferences > 0 || overview.emptyDirectories > 0) && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>{overview.missingReferences} missing file references</span>
              <span>{overview.emptyDirectories} empty directories</span>
            </div>
          )}

          <div className="inline-flex rounded-md border bg-muted/40 p-1" aria-label="Cache cleanup mode">
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
              Orphan cache
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
              Work cache
            </button>
          </div>

          {cleanupRows.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                <Checkbox
                  checked={selectedCleanupKeys.size === cleanupRows.length}
                  indeterminate={selectedCleanupKeys.size > 0 && selectedCleanupKeys.size < cleanupRows.length}
                  onCheckedChange={(checked) => setCleanupRowsSelected(cleanupRows, checked)}
                  aria-label={`Select all ${cleanupMode === "orphans" ? "orphan cache groups" : "work caches"}`}
                />
                <span>{cleanupGroups.length} groups · {cleanupRows.length} works</span>
                <span>Files</span>
                <span>Size</span>
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
                          aria-label={`Select all cache in ${group.label}`}
                        />
                        <button
                          type="button"
                          className="flex min-w-0 items-center gap-2 text-left"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.label} cache group`}
                          onClick={() => toggleCleanupGroup(group.key)}
                        >
                          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "" : "-rotate-90"}`} />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{group.label}</span>
                            <span className="block text-xs text-muted-foreground">{group.rows.length} {group.rows.length === 1 ? "work" : "works"}</span>
                          </span>
                        </button>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">{group.files}</span>
                        <span className={`whitespace-nowrap text-xs font-semibold ${cleanupMode === "orphans" ? "text-destructive" : ""}`}>{formatByteSize(group.bytes)}</span>
                      </div>
                      {expanded && visibleRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-t bg-background px-3 py-2 pl-9 text-sm">
                          <Checkbox
                            checked={selectedCleanupKeys.has(row.key)}
                            onCheckedChange={(checked) => setCleanupRowsSelected([row], checked)}
                            aria-label={`Select cache for ${row.workCode}`}
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{row.workCode}</div>
                            <div className="truncate text-xs text-muted-foreground">{row.sourceLabel}</div>
                          </div>
                          <span className="whitespace-nowrap text-xs text-muted-foreground">{row.files}</span>
                          <span className={`whitespace-nowrap text-xs font-medium ${cleanupMode === "orphans" ? "text-destructive" : ""}`}>{formatByteSize(row.bytes)}</span>
                        </div>
                      ))}
                      {expanded && remainingRows > 0 && (
                        <button
                          type="button"
                          className="w-full border-t bg-background px-3 py-2 text-xs font-medium text-primary hover:bg-muted/40"
                          onClick={() => showMoreCleanupRows(group.key)}
                        >
                          Show {Math.min(CACHE_GROUP_PAGE_SIZE, remainingRows)} more in {group.label}
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
              {cleanupMode === "orphans" ? "No eligible orphan cache groups." : "No referenced work cache is available."}
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
                ? "Queueing cleanup..."
                : confirmCleanup
                  ? `Confirm cleanup (${selectedCleanupRows.reduce((total, row) => total + row.files, 0)} files)`
                  : `Clean selected ${cleanupMode === "orphans" ? "orphans" : "works"}`}
            </Button>
            {confirmCleanup && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmCleanup(false)}>
                Cancel
              </Button>
            )}
            {cleanupStatus && <span className="text-xs text-muted-foreground">{cleanupStatus}</span>}
          </div>
        </CardContent>
      </Card>

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
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-9 w-full overflow-hidden rounded-md border bg-card sm:w-44">
      <input
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent px-3 text-right outline-none focus:ring-2 focus:ring-ring"
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="flex items-center border-l bg-muted px-3 text-xs text-muted-foreground">sec</span>
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
        groupLabel: row.sourceName.trim() || row.sourceCode.trim() || "Unknown source",
        sourceLabel: row.sourceName.trim() || row.sourceCode.trim() || "Unknown source",
        files: row.orphanFiles,
        bytes: row.orphanBytes,
      }));
  }

  const works = new Map<number, Omit<CacheCleanupRow, "groupKey" | "groupLabel" | "sourceLabel"> & { sources: Map<string, string> }>();
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
    current.sources.set(sourceKey, row.sourceName.trim() || row.sourceCode.trim() || "Unknown source");
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
        groupLabel: singleSource?.[1] ?? "Multiple sources",
        sourceLabel: singleSource?.[1] ?? `${sourceEntries.length} sources`,
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
    .map((group) => ({ ...group, rows: [...group.rows].sort((left, right) => left.workCode.localeCompare(right.workCode)) }))
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
      <div className={`mt-1 truncate text-lg font-semibold ${tone === "warning" ? "text-destructive" : ""}`}>{value}</div>
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-label={editing ? "Edit remote source" : "Add remote source"}
      aria-modal="true"
      onMouseDown={onClose}
    >
      <Card className="app-scroll max-h-[90vh] w-full max-w-2xl overflow-auto" onMouseDown={(event) => event.stopPropagation()}>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>{editing ? "Edit remote source" : "Add remote source"}</span>
            <Button variant="outline" size="icon" onClick={onClose} aria-label="Close source modal">
              <X className="h-4 w-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <TextInput label="Name" value={source.displayName} onChange={(value) => patch({ displayName: value })} />
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Source type</span>
            <select
              className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
              value={source.sourceType}
              disabled={legacyNumber178}
              onChange={(event) => patch({ sourceType: event.target.value })}
            >
              <option value="kikoeru_compatible">kikoeru_compatible</option>
              {legacyNumber178 && <option value={LEGACY_NUMBER178_SOURCE_TYPE}>{LEGACY_NUMBER178_SOURCE_TYPE}</option>}
            </select>
            {legacyNumber178 && <span className="text-xs text-muted-foreground">Legacy adapter retained for this existing source. New number178 sources are disabled.</span>}
          </label>
          <TextInput label="Public site URL" value={source.endpoint.baseUrl} onChange={(value) => patch({ endpoint: { ...source.endpoint, baseUrl: value } })} />
          <TextInput label="API URL" value={source.endpoint.apiUrl} onChange={(value) => patch({ endpoint: { ...source.endpoint, apiUrl: value } })} />
          <TextInput
            label="Work URL template"
            value={source.endpoint.workUrlTemplate}
            onChange={(value) => patch({ endpoint: { ...source.endpoint, workUrlTemplate: value } })}
          />
          <TextInput
            label="Fallback URL"
            value={source.endpoint.fallbackUrl}
            onChange={(value) => patch({ endpoint: { ...source.endpoint, fallbackUrl: value } })}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Priority</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={1}
                value={source.priority}
                onChange={(event) => patch({ priority: Number(event.target.value) })}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Cache GB</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                value={source.config.cacheLimitGb ?? 0}
                onChange={(event) => patch({ config: { ...source.config, cacheLimitGb: Number(event.target.value) } })}
              />
            </label>
          </div>
          <div className="grid gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Enabled</span>
              <Switch checked={source.enabled} onCheckedChange={(enabled) => patch({ enabled })} aria-label="Enable source" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">Cache this source</span>
              <Switch
                checked={source.config.cacheEnabled ?? false}
                onCheckedChange={(cacheEnabled) => patch({ config: { ...source.config, cacheEnabled } })}
                aria-label="Cache this source"
              />
            </div>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <ReadonlyField label="Save path preview" value={sourceSavePreview} />
            <p className="mt-2 text-xs text-muted-foreground">Example for RJ01234567. Resolved storage paths are managed in Paths.</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" disabled={!source.displayName.trim()} onClick={() => void onSave()}>
              <Save className="h-4 w-4" />
              Save
            </Button>
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
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
          Storage paths
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">These resolved paths are read-only previews derived from runtime defaults and existing source configuration.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <ReadonlyField label="Local data root" value={settings?.dataRoot ?? ""} />
          <ReadonlyField label="Cache root" value={settings?.cacheRoot ?? ""} />
          <ReadonlyField label="Remote cache path preview" value={storagePathPreview(`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`, "source")} />
          <ReadonlyField label="Remote save path preview" value={storagePathPreview(settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`, "source")} />
        </div>
        {remoteSources.length > 0 && (
          <section className="border-t pt-4">
            <h3 className="mb-3 text-sm font-semibold">Source save path previews</h3>
            <div className="grid gap-3 md:grid-cols-2">
              {remoteSources.map((source) => (
                <ReadonlyField
                  key={source.id}
                  label={source.displayName}
                  value={storagePathPreview(source.config.saveRootTemplate || settings?.remoteSaveTemplate || `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`, source.code || "source")}
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
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary text-secondary-foreground">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="truncate text-sm font-semibold">{value || "Unknown"}</div>
      </div>
    </div>
  );
}

function SourceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value || "Unknown"}</div>
    </div>
  );
}

function SettingsTabButton({ active, icon, children, onClick }: { active: boolean; icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <button
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
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
      <input className="h-9 rounded-md border bg-muted px-3 text-muted-foreground outline-none" value={value} readOnly />
    </label>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function maintenanceTabFromLocation(canManageUsers: boolean): MaintenanceTab {
  if (window.location.pathname === "/users" && canManageUsers) return "users";
  const value = new URLSearchParams(window.location.search).get("tab");
  if (value === "local" || value === "remote") return "library";
  if (value === "system") return "paths";
  const tabs: MaintenanceTab[] = ["overview", "routing", "recommendation", "library", "cache", "metadata", "users", "paths"];
  if (value && tabs.includes(value as MaintenanceTab) && (value !== "users" || canManageUsers)) return value as MaintenanceTab;
  return "overview";
}

function storagePathPreview(template: string, sourceCode: string) {
  const workCode = "RJ01234567";
  const normalizedSource = sourceCode.trim() || "source";
  const replacements: Array<[string, string]> = [
    ["<source_name>", normalizedSource],
    ["<source_code>", normalizedSource],
    ["<work_code>", workCode],
    ["<code_prefix>", "RJ"],
    ["<code_group>", "012"],
  ];
  return replacements.reduce(
    (value, [token, replacement]) => value.split(token).join(replacement),
    template.trim() || `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`,
  );
}

function splitRuleTokens(value: string) {
  return Array.from(new Set(value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)));
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

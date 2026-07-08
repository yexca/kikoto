import {
  ArrowDown,
  ArrowUp,
  Cloud,
  Database,
  Download,
  Folder,
  Gauge,
  Globe2,
  HardDrive,
  PlayCircle,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type AppSettings, type DirectoryRoutingRule, type FileSource } from "@/lib/api";

const DATA_PREFIX = "/data";
const DEFAULT_SAVE_SUFFIX = "/<source_name>/<code_prefix>/<code_group>/<work_code>";
const DEFAULT_CACHE_SUFFIX = "/media/<source_code>/<code_prefix>/<code_group>/<work_code>";
const REMOTE_SOURCE_TYPES = new Set(["kikoeru_compatible", "kikoeru_compilable_number178"]);

const emptyRemoteSource = {
  id: 0,
  code: "",
  displayName: "",
  sourceType: "kikoeru_compatible",
  priority: 30,
  enabled: true,
  config: { cacheEnabled: false, cacheLimitGb: 20, saveRootTemplate: `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}` },
  endpoint: { baseUrl: "", apiUrl: "", fallbackUrl: "" },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

type SettingsTab = "overview" | "profile" | "playback" | "local" | "remote" | "cache" | "metadata" | "system";

export function SettingsPage({ canManageSources }: { canManageSources: boolean }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<SettingsTab>("overview");
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
  const [saveSuffix, setSaveSuffix] = useState(DEFAULT_SAVE_SUFFIX);
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [isPathsOpen, setIsPathsOpen] = useState(false);

  const remoteSources = useMemo(
    () => settings?.fileSources.filter((source) => REMOTE_SOURCE_TYPES.has(source.sourceType)) ?? [],
    [settings],
  );
  const localSource = settings?.fileSources.find((source) => source.sourceType === "local_folder") ?? null;
  const saveTemplate = `${DATA_PREFIX}${normalizeSaveSuffix(saveSuffix)}`;
  const saveSuffixError = saveSuffix.trim().startsWith("/") ? "" : "Save path suffix must start with /.";

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
        setDirectoryRoutingRules(next.directoryRoutingRules ?? []);
        setSaveSuffix(templateToSuffix(next.remoteSaveTemplate));
      })
      .catch((error) => toast.notify(toastFromError(error, "Settings API is unavailable.")))
      .finally(() => setIsSettingsLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const saveRuntimeSettings = async () => {
    if (saveSuffixError) {
      toast.warning(saveSuffixError);
      return;
    }
    const next = await api.updateSettings({
      localScanDepth,
      cacheEnabled,
      cacheLimitGb,
      remoteSaveTemplate: saveTemplate,
      remoteDelayBaseSeconds: remoteDelayBase,
      remoteDelayRandomSeconds: remoteDelayRandom,
      remoteBackoffSeconds: remoteBackoff,
      remoteMaxBackoffSeconds: remoteMaxBackoff,
      circleAutoRefreshDays,
      dlsiteMetadataLanguage,
      directoryRoutingRules,
    });
    setSettings(next);
    setCacheEnabled(next.cacheEnabled);
    setSaveSuffix(templateToSuffix(next.remoteSaveTemplate));
    toast.success("Settings saved.");
  };

  const openCreateSource = () => {
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
  };

  const saveSource = async () => {
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
    await api.deleteFileSource(id);
    await reload();
    toast.success("Source deleted.");
  };

  if (!canManageSources) {
    return (
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-2 text-sm text-muted-foreground">Source and server settings are available to administrators.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Kikoto preferences</p>
            <h2 className="mt-1 text-2xl font-semibold">Settings</h2>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm sm:flex">
            {isSettingsLoading ? (
              <SettingsMetricSkeletons />
            ) : (
              <>
                <SettingsMetric label="Sources" value={String(remoteSources.length)} />
                <SettingsMetric label="Cache" value={cacheEnabled ? "On" : "Off"} />
                <SettingsMetric label="Scan" value={`${localScanDepth} levels`} />
              </>
            )}
          </div>
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
        <SettingsTabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")} icon={<SlidersHorizontal className="h-4 w-4" />}>
          Overview
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "profile"} onClick={() => setActiveTab("profile")} icon={<UserRound className="h-4 w-4" />}>
          Profile
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "playback"} onClick={() => setActiveTab("playback")} icon={<PlayCircle className="h-4 w-4" />}>
          Playback
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "local"} onClick={() => setActiveTab("local")} icon={<Folder className="h-4 w-4" />}>
          Library
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "remote"} onClick={() => setActiveTab("remote")} icon={<Cloud className="h-4 w-4" />}>
          Sources
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "cache"} onClick={() => setActiveTab("cache")} icon={<Download className="h-4 w-4" />}>
          Cache & Fetch
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "metadata"} onClick={() => setActiveTab("metadata")} icon={<RefreshCw className="h-4 w-4" />}>
          Metadata
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "system"} onClick={() => setActiveTab("system")} icon={<Server className="h-4 w-4" />}>
          System
        </SettingsTabButton>
      </div>

      {isSettingsLoading ? (
        activeTab === "overview" ? (
          <SettingsOverviewSkeleton />
        ) : activeTab === "remote" ? (
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
          saveTemplate={saveTemplate}
          onSelect={setActiveTab}
        />
      ) : activeTab === "profile" ? (
        <ComingSoonSettings
          icon={<UserRound className="h-5 w-5" />}
          title="Profile & account"
          summary="Personal display, sessions, and per-user preferences will live here."
          items={["Display name and avatar", "Language and theme preference", "Session and sign-out controls"]}
        />
      ) : activeTab === "playback" ? (
        <PlaybackSettings
          rules={directoryRoutingRules}
          onRulesChange={setDirectoryRoutingRules}
          onSave={saveRuntimeSettings}
        />
      ) : activeTab === "local" ? (
        <LocalLibrarySettings
          settings={settings}
          localSource={localSource}
          localScanDepth={localScanDepth}
          pathsOpen={isPathsOpen}
          onScanDepthChange={setLocalScanDepth}
          onPathsOpenChange={setIsPathsOpen}
          onSave={saveRuntimeSettings}
        />
      ) : activeTab === "remote" ? (
        <RemoteSourcesSettings
          remoteSources={remoteSources}
          onCreateSource={openCreateSource}
          onEditSource={openEditSource}
          onDeleteSource={deleteSource}
        />
      ) : activeTab === "cache" ? (
        <CacheFetchSettings
          settings={settings}
          cacheEnabled={cacheEnabled}
          cacheLimitGb={cacheLimitGb}
          remoteDelayBase={remoteDelayBase}
          remoteDelayRandom={remoteDelayRandom}
          remoteBackoff={remoteBackoff}
          remoteMaxBackoff={remoteMaxBackoff}
          saveSuffix={saveSuffix}
          saveTemplate={saveTemplate}
          saveSuffixError={saveSuffixError}
          onCacheEnabledChange={setCacheEnabled}
          onCacheLimitChange={setCacheLimitGb}
          onRemoteDelayBaseChange={setRemoteDelayBase}
          onRemoteDelayRandomChange={setRemoteDelayRandom}
          onRemoteBackoffChange={setRemoteBackoff}
          onRemoteMaxBackoffChange={setRemoteMaxBackoff}
          onSaveSuffixChange={setSaveSuffix}
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
      ) : (
        <SystemPathsSettings settings={settings} saveTemplate={saveTemplate} />
      )}

      {isSourceModalOpen && (
        <SourceModal
          source={draftSource}
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
  saveTemplate,
  onSelect,
}: {
  remoteSources: FileSource[];
  localSource: FileSource | null;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  localScanDepth: number;
  circleAutoRefreshDays: number;
  saveTemplate: string;
  onSelect: (tab: SettingsTab) => void;
}) {
  const enabledSources = remoteSources.filter((source) => source.enabled).length;
  const warningSources = remoteSources.filter((source) => ["error", "unavailable", "disabled"].includes(source.healthStatus)).length;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      <SettingsHomeCard
        icon={<UserRound className="h-5 w-5" />}
        title="Profile & account"
        description="Personal display, session, and preference settings."
        status="Planned"
        chips={["Per-user", "Theme", "Session"]}
        onClick={() => onSelect("profile")}
      />
      <SettingsHomeCard
        icon={<PlayCircle className="h-5 w-5" />}
        title="Playback"
        description="Default player behavior, lyrics, source preference, and listening comfort."
        status="Planned"
        chips={["Player", "Lyrics", "Timer"]}
        onClick={() => onSelect("playback")}
      />
      <SettingsHomeCard
        icon={<Folder className="h-5 w-5" />}
        title="Library"
        description="Local source scan behavior and library root visibility."
        status={localSource?.enabled ? "Active" : "Needs scan"}
        chips={[localSource?.displayName ?? "Main local library", `${localScanDepth} scan levels`]}
        onClick={() => onSelect("local")}
      />
      <SettingsHomeCard
        icon={<Cloud className="h-5 w-5" />}
        title="Remote sources"
        description="Manage configured file sources, health, and priority."
        status={`${enabledSources}/${remoteSources.length} enabled`}
        chips={[warningSources > 0 ? `${warningSources} warnings` : "Healthy", "Priority", "Endpoints"]}
        onClick={() => onSelect("remote")}
      />
      <SettingsHomeCard
        icon={<Download className="h-5 w-5" />}
        title="Cache & fetch"
        description="Remote playback cache, save path, and download pacing."
        status={cacheEnabled ? "Auto cache on" : "Auto cache off"}
        chips={[`${cacheLimitGb} GB limit`, saveTemplate]}
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
        title="System paths"
        description="Read-only runtime roots and derived storage templates."
        status="Read only"
        chips={["/data", "/cache", "Docker"]}
        onClick={() => onSelect("system")}
      />
      <SettingsHomeCard
        icon={<Shield className="h-5 w-5" />}
        title="Administration"
        description="Role-gated controls for source and server configuration."
        status="Admin"
        chips={["Sources", "Workflows", "Users"]}
        onClick={() => onSelect("system")}
      />
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

function ComingSoonSettings({
  icon,
  title,
  summary,
  items,
}: {
  icon: ReactNode;
  title: string;
  summary: string;
  items: string[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{summary}</p>
        <div className="grid gap-3 md:grid-cols-3">
          {items.map((item) => (
            <div key={item} className="rounded-lg border bg-background p-3 text-sm">
              <div className="font-medium">{item}</div>
              <div className="mt-1 text-xs text-muted-foreground">Reserved for a later user-settings slice.</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
  const patchRule = (index: number, patch: Partial<DirectoryRoutingRule>) => {
    onRulesChange(rules.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
  };
  const moveRule = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= rules.length) return;
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(nextIndex, 0, rule);
    onRulesChange(next);
  };
  const addRule = () => {
    onRulesChange([
      ...rules,
      {
        id: `rule_${Date.now()}`,
        label: "New rule",
        weight: 10,
        aliases: ["keyword"],
        negativeAliases: [],
        enabled: true,
      },
    ]);
  };
  const removeRule = (index: number) => onRulesChange(rules.filter((_, ruleIndex) => ruleIndex !== index));
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
          <div className="grid gap-3 md:grid-cols-3">
            <StatusPanel icon={<Folder className="h-4 w-4" />} label="Directory routing" value={rules.length > 0 ? "Enabled" : "No rules"} />
            <StatusPanel icon={<SlidersHorizontal className="h-4 w-4" />} label="Match model" value="Weighted aliases" />
            <StatusPanel icon={<Gauge className="h-4 w-4" />} label="Fallback" value="Most audio" />
          </div>
          <div className="space-y-3">
            {rules.map((rule, index) => (
              <DirectoryRuleEditor
                key={rule.id || index}
                rule={rule}
                index={index}
                canMoveUp={index > 0}
                canMoveDown={index < rules.length - 1}
                onPatch={(patch) => patchRule(index, patch)}
                onMove={moveRule}
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
  onRemove,
}: {
  rule: DirectoryRoutingRule;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPatch: (patch: Partial<DirectoryRoutingRule>) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`rounded-lg border bg-background p-3 ${rule.enabled ? "" : "opacity-65"}`}>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="flex items-center gap-2">
          <button
            className="grid h-8 w-8 place-items-center rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-40"
            disabled={!canMoveUp}
            onClick={() => onMove(index, -1)}
            aria-label="Move rule up"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            className="grid h-8 w-8 place-items-center rounded-md border text-muted-foreground hover:bg-muted disabled:opacity-40"
            disabled={!canMoveDown}
            onClick={() => onMove(index, 1)}
            aria-label="Move rule down"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-[minmax(0,1fr)_120px_120px]">
          <TextInput label="Rule name" value={rule.label} onChange={(value) => onPatch({ label: value })} />
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Weight</span>
            <input
              className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
              type="number"
              min={1}
              max={100}
              value={rule.weight}
              onChange={(event) => onPatch({ weight: Number(event.target.value) })}
            />
          </label>
          <label className="flex min-h-9 items-center justify-between gap-3 self-end rounded-md border px-3 text-sm">
            <span className="font-medium">Enabled</span>
            <input type="checkbox" checked={rule.enabled} onChange={(event) => onPatch({ enabled: event.target.checked })} />
          </label>
        </div>
        <Button variant="outline" size="icon" aria-label="Remove rule" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <TagListInput
          label="Aliases"
          value={rule.aliases}
          onChange={(aliases) => onPatch({ aliases })}
        />
        <TagListInput
          label="Negative aliases"
          value={rule.negativeAliases}
          onChange={(negativeAliases) => onPatch({ negativeAliases })}
        />
      </div>
    </div>
  );
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

function SettingsMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-semibold">{value}</div>
    </div>
  );
}

function SettingsSkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function SettingsMetricSkeletons() {
  return (
    <>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="rounded-md border bg-background px-3 py-2">
          <SettingsSkeletonLine className="h-3 w-14" />
          <SettingsSkeletonLine className="mt-2 h-5 w-12" />
        </div>
      ))}
    </>
  );
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
        <div className="grid gap-3 md:grid-cols-3">
          <StatusPanel icon={<Globe2 className="h-4 w-4" />} label="Metadata language" value={languageName(dlsiteMetadataLanguage)} />
          <StatusPanel icon={<RefreshCw className="h-4 w-4" />} label="Circle refresh" value={circleAutoRefreshDays === 0 ? "Manual" : `${circleAutoRefreshDays} days`} />
          <StatusPanel icon={<Database className="h-4 w-4" />} label="Provider" value="DLsite" />
        </div>
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

function LocalLibrarySettings({
  settings,
  localSource,
  localScanDepth,
  pathsOpen,
  onScanDepthChange,
  onPathsOpenChange,
  onSave,
}: {
  settings: AppSettings | null;
  localSource: FileSource | null;
  localScanDepth: number;
  pathsOpen: boolean;
  onScanDepthChange: (value: number) => void;
  onPathsOpenChange: (value: boolean) => void;
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
          <div className="grid gap-3 md:grid-cols-3">
            <StatusPanel icon={<HardDrive className="h-4 w-4" />} label="Source" value={localSource?.displayName ?? "Main local library"} />
            <StatusPanel icon={<Gauge className="h-4 w-4" />} label="Scan depth" value={`${localScanDepth} levels`} />
            <StatusPanel icon={<Shield className="h-4 w-4" />} label="State" value={localSource?.enabled ? "Enabled" : "Not scanned"} />
          </div>
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

      <details className="rounded-lg border bg-card" open={pathsOpen} onToggle={(event) => onPathsOpenChange(event.currentTarget.open)}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">
          <Settings2 className="h-4 w-4 text-primary" />
          Program paths
        </summary>
        <div className="grid gap-3 border-t p-4 md:grid-cols-2">
          <ReadonlyField label="Local data root" value={settings?.dataRoot ?? ""} />
          <ReadonlyField label="Cache root" value={settings?.cacheRoot ?? ""} />
          <ReadonlyField label="Remote cache path" value={`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`} />
          <ReadonlyField label="Remote fetch path" value={`${settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`}`} />
        </div>
      </details>
    </div>
  );
}

function RemoteSourcesSettings({
  remoteSources,
  onCreateSource,
  onEditSource,
  onDeleteSource,
}: {
  remoteSources: FileSource[];
  onCreateSource: () => void;
  onEditSource: (source: FileSource) => void;
  onDeleteSource: (id: number) => Promise<void>;
}) {
  const enabledSources = remoteSources.filter((source) => source.enabled).length;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4">
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
          <StatusPanel icon={<Gauge className="h-4 w-4" />} label="Priority model" value="Per source" />
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
  settings,
  cacheEnabled,
  cacheLimitGb,
  remoteDelayBase,
  remoteDelayRandom,
  remoteBackoff,
  remoteMaxBackoff,
  saveSuffix,
  saveTemplate,
  saveSuffixError,
  onCacheEnabledChange,
  onCacheLimitChange,
  onRemoteDelayBaseChange,
  onRemoteDelayRandomChange,
  onRemoteBackoffChange,
  onRemoteMaxBackoffChange,
  onSaveSuffixChange,
  onSave,
}: {
  settings: AppSettings | null;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  remoteDelayBase: number;
  remoteDelayRandom: number;
  remoteBackoff: number;
  remoteMaxBackoff: number;
  saveSuffix: string;
  saveTemplate: string;
  saveSuffixError: string;
  onCacheEnabledChange: (value: boolean) => void;
  onCacheLimitChange: (value: number) => void;
  onRemoteDelayBaseChange: (value: number) => void;
  onRemoteDelayRandomChange: (value: number) => void;
  onRemoteBackoffChange: (value: number) => void;
  onRemoteMaxBackoffChange: (value: number) => void;
  onSaveSuffixChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
              <Download className="h-4 w-4" />
            </span>
            Cache & fetch
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <StatusPanel icon={<Database className="h-4 w-4" />} label="Playback cache" value={cacheEnabled ? "Enabled" : "Disabled"} />
            <StatusPanel icon={<HardDrive className="h-4 w-4" />} label="Cache limit" value={`${cacheLimitGb} GB`} />
            <StatusPanel icon={<Gauge className="h-4 w-4" />} label="Backoff max" value={`${remoteMaxBackoff}s`} />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-sm">
              <span className="font-medium">Cache remote playback</span>
              <input type="checkbox" checked={cacheEnabled} onChange={(event) => onCacheEnabledChange(event.target.checked)} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Total limit GB</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                value={cacheLimitGb}
                onChange={(event) => onCacheLimitChange(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Delay base sec</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                step={0.1}
                value={remoteDelayBase}
                onChange={(event) => onRemoteDelayBaseChange(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Delay random sec</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                step={0.1}
                value={remoteDelayRandom}
                onChange={(event) => onRemoteDelayRandomChange(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">429 backoff sec</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                step={1}
                value={remoteBackoff}
                onChange={(event) => onRemoteBackoffChange(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Max backoff sec</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                step={1}
                value={remoteMaxBackoff}
                onChange={(event) => onRemoteMaxBackoffChange(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="grid gap-1 text-sm">
            <span className="font-medium">Save path template</span>
            <div className="flex min-h-9 overflow-hidden rounded-md border bg-card">
              <div className="flex items-center border-r bg-muted px-3 text-muted-foreground">{DATA_PREFIX}</div>
              <input
                className="min-w-0 flex-1 bg-transparent px-3 outline-none focus:ring-2 focus:ring-ring"
                value={saveSuffix}
                onChange={(event) => onSaveSuffixChange(event.target.value)}
                placeholder={DEFAULT_SAVE_SUFFIX}
              />
            </div>
            <div className={saveSuffixError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {saveSuffixError || saveTemplate}
            </div>
          </div>

          <div className="grid gap-2 text-sm md:grid-cols-2">
            <ReadonlyField label="Remote cache root" value={`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`} />
            <ReadonlyField label="Remote fetch root" value={saveTemplate} />
          </div>

          <Button size="sm" onClick={() => void onSave()} disabled={Boolean(saveSuffixError)}>
            <Save className="h-4 w-4" />
            Save cache & fetch settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function SourceModal({
  source,
  editing,
  onChange,
  onSave,
  onClose,
}: {
  source: FileSource;
  editing: boolean;
  onChange: (source: FileSource) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const patch = (next: Partial<FileSource>) => onChange({ ...source, ...next });
  const sourceSaveSuffix = templateToSuffix(source.config.saveRootTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`);
  const sourceSaveError = sourceSaveSuffix.startsWith("/") ? "" : "Save path suffix must start with /.";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <Card className="max-h-[90vh] w-full max-w-2xl overflow-auto" onMouseDown={(event) => event.stopPropagation()}>
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
              onChange={(event) => patch({ sourceType: event.target.value })}
            >
              <option value="kikoeru_compatible">kikoeru_compatible</option>
              <option value="kikoeru_compilable_number178">kikoeru_compilable_number178</option>
            </select>
          </label>
          <TextInput label="Base URL" value={source.endpoint.baseUrl} onChange={(value) => patch({ endpoint: { ...source.endpoint, baseUrl: value } })} />
          <TextInput label="API URL" value={source.endpoint.apiUrl} onChange={(value) => patch({ endpoint: { ...source.endpoint, apiUrl: value } })} />
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
            <label className="flex items-center justify-between gap-3">
              <span className="font-medium">Enabled</span>
              <input type="checkbox" checked={source.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="font-medium">Cache this source</span>
              <input
                type="checkbox"
                checked={source.config.cacheEnabled ?? false}
                onChange={(event) => patch({ config: { ...source.config, cacheEnabled: event.target.checked } })}
              />
            </label>
          </div>
          <div className="grid gap-1 text-sm">
            <span className="font-medium">Save path template</span>
            <div className="flex min-h-9 overflow-hidden rounded-md border bg-card">
              <div className="flex items-center border-r bg-muted px-3 text-muted-foreground">{DATA_PREFIX}</div>
              <input
                className="min-w-0 flex-1 bg-transparent px-3 outline-none focus:ring-2 focus:ring-ring"
                value={sourceSaveSuffix}
                onChange={(event) =>
                  patch({ config: { ...source.config, saveRootTemplate: `${DATA_PREFIX}${normalizeSaveSuffix(event.target.value)}` } })
                }
              />
            </div>
            <div className={sourceSaveError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {sourceSaveError || source.config.saveRootTemplate}
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" disabled={!source.displayName.trim() || Boolean(sourceSaveError)} onClick={() => void onSave()}>
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

function SystemPathsSettings({ settings, saveTemplate }: { settings: AppSettings | null; saveTemplate: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <Server className="h-4 w-4" />
          </span>
          System paths
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <StatusPanel icon={<HardDrive className="h-4 w-4" />} label="Data root" value={settings?.dataRoot ?? "/data"} />
          <StatusPanel icon={<Database className="h-4 w-4" />} label="Cache root" value={settings?.cacheRoot ?? "/cache"} />
          <StatusPanel icon={<Download className="h-4 w-4" />} label="Fetch root" value={saveTemplate} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <ReadonlyField label="Local data root" value={settings?.dataRoot ?? ""} />
          <ReadonlyField label="Cache root" value={settings?.cacheRoot ?? ""} />
          <ReadonlyField label="Remote cache path" value={`${settings?.cacheRoot ?? ""}${DEFAULT_CACHE_SUFFIX}`} />
          <ReadonlyField label="Remote fetch path" value={`${settings?.remoteSaveTemplate ?? `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`}`} />
        </div>
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

function templateToSuffix(value: string) {
  const trimmed = value.trim() || `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}`;
  if (trimmed === DATA_PREFIX) return DEFAULT_SAVE_SUFFIX;
  if (trimmed.startsWith(`${DATA_PREFIX}/`)) return trimmed.slice(DATA_PREFIX.length);
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeSaveSuffix(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_SAVE_SUFFIX;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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

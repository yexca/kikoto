import { Database, Folder, Plus, Save, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AppSettings, type FileSource } from "@/lib/api";

const DATA_PREFIX = "/data";
const DEFAULT_SAVE_SUFFIX = "/<source_name>/<work_code>";

const emptyRemoteSource = {
  id: 0,
  code: "",
  displayName: "",
  sourceType: "kikoeru_compatible",
  priority: 30,
  enabled: true,
  config: { autoSyncOnInterest: false, cacheEnabled: false, cacheLimitGb: 20, saveRootTemplate: `${DATA_PREFIX}${DEFAULT_SAVE_SUFFIX}` },
  endpoint: { baseUrl: "", apiUrl: "", fallbackUrl: "" },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

type SettingsTab = "local" | "remote";

export function SettingsPage({ canManageSources }: { canManageSources: boolean }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("local");
  const [localScanDepth, setLocalScanDepth] = useState(2);
  const [autoSyncRemote, setAutoSyncRemote] = useState(false);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheLimitGb, setCacheLimitGb] = useState(20);
  const [saveSuffix, setSaveSuffix] = useState(DEFAULT_SAVE_SUFFIX);
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [isSourceModalOpen, setIsSourceModalOpen] = useState(false);
  const [isPathsOpen, setIsPathsOpen] = useState(false);
  const [message, setMessage] = useState("");

  const remoteSources = useMemo(
    () => settings?.fileSources.filter((source) => source.sourceType === "kikoeru_compatible") ?? [],
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
        setAutoSyncRemote(next.autoSyncRemote);
        setCacheEnabled(next.cacheEnabled);
        setCacheLimitGb(next.cacheLimitGb);
        setSaveSuffix(templateToSuffix(next.remoteSaveTemplate));
      })
      .catch(() => setMessage("Settings API is unavailable."));

  useEffect(() => {
    void reload();
  }, []);

  const saveRuntimeSettings = async () => {
    if (saveSuffixError) {
      setMessage(saveSuffixError);
      return;
    }
    const next = await api.updateSettings({
      localScanDepth,
      autoSyncRemote: cacheEnabled ? true : autoSyncRemote,
      cacheEnabled,
      cacheLimitGb,
      remoteSaveTemplate: saveTemplate,
    });
    setSettings(next);
    setAutoSyncRemote(next.autoSyncRemote);
    setCacheEnabled(next.cacheEnabled);
    setSaveSuffix(templateToSuffix(next.remoteSaveTemplate));
    setMessage("Settings saved.");
  };

  const openCreateSource = () => {
    setDraftSource(emptyRemoteSource);
    setEditingSourceId(null);
    setIsSourceModalOpen(true);
    setMessage("");
  };

  const openEditSource = (source: FileSource) => {
    setDraftSource(source);
    setEditingSourceId(source.id);
    setIsSourceModalOpen(true);
    setMessage("");
  };

  const closeSourceModal = () => {
    setIsSourceModalOpen(false);
    setDraftSource(emptyRemoteSource);
    setEditingSourceId(null);
  };

  const saveSource = async () => {
    const payload = {
      displayName: draftSource.displayName,
      sourceType: "kikoeru_compatible",
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
    setMessage("Source saved.");
  };

  const deleteSource = async (id: number) => {
    await api.deleteFileSource(id);
    await reload();
    setMessage("Source deleted.");
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
    <div className="space-y-4">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
        <SettingsTabButton active={activeTab === "local"} onClick={() => setActiveTab("local")} icon={<Folder className="h-4 w-4" />}>
          Local library
        </SettingsTabButton>
        <SettingsTabButton active={activeTab === "remote"} onClick={() => setActiveTab("remote")} icon={<Database className="h-4 w-4" />}>
          Remote sources
        </SettingsTabButton>
      </div>

      {activeTab === "local" ? (
        <LocalLibrarySettings
          settings={settings}
          localSource={localSource}
          localScanDepth={localScanDepth}
          pathsOpen={isPathsOpen}
          onScanDepthChange={setLocalScanDepth}
          onPathsOpenChange={setIsPathsOpen}
          onSave={saveRuntimeSettings}
        />
      ) : (
        <RemoteSourceSettings
          settings={settings}
          remoteSources={remoteSources}
          autoSyncRemote={autoSyncRemote}
          cacheEnabled={cacheEnabled}
          cacheLimitGb={cacheLimitGb}
          saveSuffix={saveSuffix}
          saveTemplate={saveTemplate}
          saveSuffixError={saveSuffixError}
          onAutoSyncChange={setAutoSyncRemote}
          onCacheEnabledChange={(value) => {
            setCacheEnabled(value);
            if (value) setAutoSyncRemote(true);
          }}
          onCacheLimitChange={setCacheLimitGb}
          onSaveSuffixChange={setSaveSuffix}
          onSave={saveRuntimeSettings}
          onCreateSource={openCreateSource}
          onEditSource={openEditSource}
          onDeleteSource={deleteSource}
        />
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
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-primary" />
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

      <details className="rounded-lg border bg-card" open={pathsOpen} onToggle={(event) => onPathsOpenChange(event.currentTarget.open)}>
        <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-semibold">
          <Settings2 className="h-4 w-4 text-primary" />
          Program paths
        </summary>
        <div className="grid gap-3 border-t p-4 md:grid-cols-2">
          <ReadonlyField label="Local data root" value={settings?.dataRoot ?? ""} />
          <ReadonlyField label="Cache root" value={settings?.cacheRoot ?? ""} />
          <ReadonlyField label="Remote cache path" value={`${settings?.cacheRoot ?? ""}/voiceworks_<source_name>/<work_code>`} />
          <ReadonlyField label="Remote save path" value={`${settings?.remoteSaveTemplate ?? "/data/<source_name>/<work_code>"}`} />
        </div>
      </details>
    </div>
  );
}

function RemoteSourceSettings({
  settings,
  remoteSources,
  autoSyncRemote,
  cacheEnabled,
  cacheLimitGb,
  saveSuffix,
  saveTemplate,
  saveSuffixError,
  onAutoSyncChange,
  onCacheEnabledChange,
  onCacheLimitChange,
  onSaveSuffixChange,
  onSave,
  onCreateSource,
  onEditSource,
  onDeleteSource,
}: {
  settings: AppSettings | null;
  remoteSources: FileSource[];
  autoSyncRemote: boolean;
  cacheEnabled: boolean;
  cacheLimitGb: number;
  saveSuffix: string;
  saveTemplate: string;
  saveSuffixError: string;
  onAutoSyncChange: (value: boolean) => void;
  onCacheEnabledChange: (value: boolean) => void;
  onCacheLimitChange: (value: number) => void;
  onSaveSuffixChange: (value: string) => void;
  onSave: () => Promise<void>;
  onCreateSource: () => void;
  onEditSource: (source: FileSource) => void;
  onDeleteSource: (id: number) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Remote cache
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-sm">
              <span className="font-medium">Auto pull</span>
              <input type="checkbox" checked={autoSyncRemote || cacheEnabled} disabled={cacheEnabled} onChange={(event) => onAutoSyncChange(event.target.checked)} />
            </label>
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-sm">
              <span className="font-medium">Auto cache</span>
              <input type="checkbox" checked={cacheEnabled} onChange={(event) => onCacheEnabledChange(event.target.checked)} />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Limit GB</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                value={cacheLimitGb}
                onChange={(event) => onCacheLimitChange(Number(event.target.value))}
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
            <ReadonlyField label="Remote cache root" value={`${settings?.cacheRoot ?? ""}/voiceworks_<source_name>/<work_code>`} />
            <ReadonlyField label="Remote save root" value={saveTemplate} />
          </div>

          <Button size="sm" onClick={() => void onSave()} disabled={Boolean(saveSuffixError)}>
            <Save className="h-4 w-4" />
            Save remote settings
          </Button>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Remote sources</h2>
            <p className="text-sm text-muted-foreground">Kikoeru-compatible sources stay configurable and are not hard-coded into the app.</p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreateSource}>
            <Plus className="h-4 w-4" />
            Add source
          </Button>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {remoteSources.map((source) => (
            <Card key={source.id}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-primary" />
                  {source.displayName}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={source.enabled ? "outline" : "warning"}>{source.enabled ? "enabled" : "disabled"}</Badge>
                  <Badge variant="secondary">{source.healthStatus}</Badge>
                  <Badge variant="outline">Priority {source.priority}</Badge>
                  {source.config.cacheEnabled && <Badge variant="outline">cache</Badge>}
                </div>
                <p className="truncate text-sm text-muted-foreground">{source.endpoint.baseUrl || source.endpoint.apiUrl || "No endpoint configured"}</p>
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
      </section>
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
              <span className="font-medium">Auto pull on interest</span>
              <input
                type="checkbox"
                checked={source.config.autoSyncOnInterest ?? false}
                disabled={source.config.cacheEnabled ?? false}
                onChange={(event) => patch({ config: { ...source.config, autoSyncOnInterest: event.target.checked } })}
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="font-medium">Cache this source</span>
              <input
                type="checkbox"
                checked={source.config.cacheEnabled ?? false}
                onChange={(event) =>
                  patch({
                    config: {
                      ...source.config,
                      cacheEnabled: event.target.checked,
                      autoSyncOnInterest: event.target.checked ? true : source.config.autoSyncOnInterest,
                    },
                  })
                }
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

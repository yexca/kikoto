import { Database, Folder, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type AppSettings, type FileSource } from "@/lib/api";

const emptyRemoteSource = {
  id: 0,
  code: "",
  displayName: "",
  sourceType: "kikoeru_compatible",
  priority: 30,
  enabled: true,
  config: { autoSyncOnInterest: false, cacheEnabled: false, cacheLimitGb: 20, saveRootTemplate: "/data/<source_name>/<work_code>" },
  endpoint: { baseUrl: "", apiUrl: "", fallbackUrl: "" },
  healthStatus: "unknown",
  lastCheckedAt: null,
} satisfies FileSource;

export function SettingsPage({ canManageSources }: { canManageSources: boolean }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [localScanDepth, setLocalScanDepth] = useState(2);
  const [autoSyncRemote, setAutoSyncRemote] = useState(false);
  const [cacheEnabled, setCacheEnabled] = useState(false);
  const [cacheLimitGb, setCacheLimitGb] = useState(20);
  const [remoteSaveTemplate, setRemoteSaveTemplate] = useState("/data/<source_name>/<work_code>");
  const [draftSource, setDraftSource] = useState<FileSource>(emptyRemoteSource);
  const [editingSourceId, setEditingSourceId] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const remoteSources = useMemo(
    () => settings?.fileSources.filter((source) => source.sourceType === "kikoeru_compatible") ?? [],
    [settings],
  );
  const localSource = settings?.fileSources.find((source) => source.sourceType === "local_folder") ?? null;

  const reload = () =>
    api
      .getSettings()
      .then((next) => {
        setSettings(next);
        setLocalScanDepth(next.localScanDepth);
        setAutoSyncRemote(next.autoSyncRemote);
        setCacheEnabled(next.cacheEnabled);
        setCacheLimitGb(next.cacheLimitGb);
        setRemoteSaveTemplate(next.remoteSaveTemplate);
      })
      .catch(() => setMessage("Settings API is unavailable."));

  useEffect(() => {
    void reload();
  }, []);

  const saveRuntimeSettings = async () => {
    const next = await api.updateSettings({ localScanDepth, autoSyncRemote: cacheEnabled ? true : autoSyncRemote, cacheEnabled, cacheLimitGb, remoteSaveTemplate });
    setSettings(next);
    setAutoSyncRemote(next.autoSyncRemote);
    setCacheEnabled(next.cacheEnabled);
    setMessage("Settings saved.");
  };

  const editSource = (source: FileSource) => {
    setDraftSource(source);
    setEditingSourceId(source.id);
    setMessage("");
  };

  const resetSourceForm = () => {
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
    resetSourceForm();
    await reload();
    setMessage("Source saved.");
  };

  const deleteSource = async (id: number) => {
    await api.deleteFileSource(id);
    if (editingSourceId === id) resetSourceForm();
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

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Folder className="h-4 w-4 text-primary" />
              Local library
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Field label="Data root" value={settings?.dataRoot ?? ""} readOnly />
            <Field label="Cache root" value={settings?.cacheRoot ?? ""} readOnly />
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Scan depth</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={1}
                max={8}
                value={localScanDepth}
                onChange={(event) => setLocalScanDepth(Number(event.target.value))}
              />
            </label>
            <div className="md:col-span-3 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{localSource?.displayName ?? "Main local library"}</Badge>
              <Badge variant="outline">{localSource?.enabled ? "enabled" : "not scanned"}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              Remote cache
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-sm">
              <span className="font-medium">Auto pull on interest</span>
              <input type="checkbox" checked={autoSyncRemote || cacheEnabled} disabled={cacheEnabled} onChange={(event) => setAutoSyncRemote(event.target.checked)} />
            </label>
            <label className="flex min-h-9 items-center justify-between gap-3 rounded-md border px-3 text-sm">
              <span className="font-medium">Auto cache on play</span>
              <input
                type="checkbox"
                checked={cacheEnabled}
                onChange={(event) => {
                  setCacheEnabled(event.target.checked);
                  if (event.target.checked) setAutoSyncRemote(true);
                }}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Limit GB</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={0}
                value={cacheLimitGb}
                onChange={(event) => setCacheLimitGb(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="font-medium">Save path template</span>
              <input
                className="h-9 rounded-md border bg-card px-3 outline-none focus:ring-2 focus:ring-ring"
                value={remoteSaveTemplate}
                onChange={(event) => setRemoteSaveTemplate(event.target.value)}
              />
            </label>
            <Button size="sm" className="w-full" onClick={() => void saveRuntimeSettings()}>
              <Save className="h-4 w-4" />
              Save settings
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Kikoeru-compatible sources</h2>
              <p className="text-sm text-muted-foreground">Remote servers stay configurable and are not hard-coded into the app.</p>
            </div>
            <Button variant="outline" size="sm" onClick={resetSourceForm}>
              <Plus className="h-4 w-4" />
              New
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
                    <Badge variant="secondary">{source.sourceType}</Badge>
                    <Badge variant={source.enabled ? "outline" : "warning"}>{source.enabled ? "enabled" : "disabled"}</Badge>
                    <Badge variant="outline">Priority {source.priority}</Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">{source.endpoint.baseUrl || "No base URL configured"}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => editSource(source)}>
                      Configure
                    </Button>
                    <Button variant="outline" size="icon" aria-label="Delete source" onClick={() => void deleteSource(source.id)}>
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

        <SourceForm source={draftSource} editing={editingSourceId !== null} onChange={setDraftSource} onSave={saveSource} onReset={resetSourceForm} />
      </section>
    </div>
  );
}

function Field({ label, value, readOnly }: { label: string; value: string; readOnly?: boolean }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input className="h-9 rounded-md border bg-muted px-3 text-muted-foreground outline-none" value={value} readOnly={readOnly} />
    </label>
  );
}

function SourceForm({
  source,
  editing,
  onChange,
  onSave,
  onReset,
}: {
  source: FileSource;
  editing: boolean;
  onChange: (source: FileSource) => void;
  onSave: () => Promise<void>;
  onReset: () => void;
}) {
  const patch = (next: Partial<FileSource>) => onChange({ ...source, ...next });
  return (
    <Card className="self-start">
      <CardHeader>
        <CardTitle>{editing ? "Edit source" : "Add source"}</CardTitle>
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
        <TextInput
          label="Save path template"
          value={source.config.saveRootTemplate ?? ""}
          onChange={(value) => patch({ config: { ...source.config, saveRootTemplate: value } })}
        />
        <div className="flex gap-2">
          <Button size="sm" className="flex-1" disabled={!source.displayName.trim()} onClick={() => void onSave()}>
            <Save className="h-4 w-4" />
            Save
          </Button>
          <Button variant="outline" size="sm" onClick={onReset}>
            Clear
          </Button>
        </div>
      </CardContent>
    </Card>
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

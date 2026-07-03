import {
  Activity,
  CalendarClock,
  Database,
  ListChecks,
  Play,
  Plus,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type WorkflowDefinition, type WorkflowRun, type WorkflowTrigger } from "@/lib/api";

type Surface = "workflows" | "activity";
type WorkflowView = "definitions" | "scheduled" | "system";
type ActivityView = "running" | "history" | "failed";

type WorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
};

const nodeOptions = [
  "select_local_source",
  "discover_local_files",
  "select_remote_source",
  "discover_remote_works",
  "select_works",
  "select_media_items",
  "filter_candidates",
  "match_works",
  "sync_file_locations",
  "sync_metadata",
  "materialize_cache",
  "materialize_save",
] as const;

const triggerTypes = ["startup", "schedule", "filesystem_event", "source_poll"] as const;

const defaultNodes: WorkflowNode[] = [
  { id: "select", type: "select_works", displayName: "Select works" },
  { id: "sync", type: "sync_metadata", displayName: "Sync metadata" },
];

export function WorkflowsPage({
  surface,
  canRun,
  canSyncMetadata,
}: {
  surface: Surface;
  canRun: boolean;
  canSyncMetadata: boolean;
}) {
  const [workflowView, setWorkflowView] = useState<WorkflowView>("definitions");
  const [activityView, setActivityView] = useState<ActivityView>("running");
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);

  const refresh = () => {
    api.listWorkflowDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
    api.listWorkflowTriggers().then(setTriggers).catch(() => setTriggers([]));
    api.listWorkflowRuns().then(setRuns).catch(() => setRuns([]));
  };

  useEffect(() => {
    refresh();
  }, []);

  const runLocalScan = async () => {
    setIsRunningScan(true);
    try {
      await api.runLocalScan();
      refresh();
      setActivityView("history");
    } finally {
      setIsRunningScan(false);
    }
  };

  const runMetadataSync = async () => {
    setIsSyncingMetadata(true);
    try {
      await api.runDLsiteSync();
      refresh();
      setActivityView("history");
    } finally {
      setIsSyncingMetadata(false);
    }
  };

  const userDefinitions = definitions.filter((definition) => definition.scope === "user");
  const systemDefinitions = definitions.filter((definition) => definition.scope === "system");
  const scheduledTriggers = triggers.filter((trigger) => trigger.triggerType !== "manual");
  const runningRuns = runs.filter((run) => ["queued", "running"].includes(run.status));
  const failedRuns = runs.filter((run) => run.status === "failed");
  const historyRuns = runs.filter((run) => !["queued", "running"].includes(run.status));

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{surface === "activity" ? "Activity" : "Workflows"}</h2>
          <p className="text-sm text-muted-foreground">
            {surface === "activity" ? "Running jobs and historical workflow executions." : "Definitions are editable workflows; scheduled contains non-manual triggers."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={runLocalScan} disabled={isRunningScan || !canRun}>
            <Play className="h-4 w-4" />
            {isRunningScan ? "Running" : "Run local scan"}
          </Button>
          <Button size="sm" variant="outline" onClick={runMetadataSync} disabled={isSyncingMetadata || !canSyncMetadata}>
            <Play className="h-4 w-4" />
            {isSyncingMetadata ? "Syncing" : "Sync metadata"}
          </Button>
        </div>
      </div>

      {surface === "workflows" ? (
        <>
          <SegmentedNav>
            <ViewButton active={workflowView === "definitions"} onClick={() => setWorkflowView("definitions")} icon={<Workflow className="h-4 w-4" />}>
              Definitions
            </ViewButton>
            <ViewButton active={workflowView === "scheduled"} onClick={() => setWorkflowView("scheduled")} icon={<CalendarClock className="h-4 w-4" />}>
              Scheduled
            </ViewButton>
            <ViewButton active={workflowView === "system"} onClick={() => setWorkflowView("system")} icon={<Database className="h-4 w-4" />}>
              System
            </ViewButton>
          </SegmentedNav>

          {workflowView === "definitions" && <DefinitionWorkspace definitions={userDefinitions} onRefresh={refresh} />}
          {workflowView === "scheduled" && <ScheduledWorkspace definitions={definitions} triggers={scheduledTriggers} onRefresh={refresh} />}
          {workflowView === "system" && <DefinitionList definitions={systemDefinitions} readonly />}
        </>
      ) : (
        <>
          <SegmentedNav>
            <ViewButton active={activityView === "running"} onClick={() => setActivityView("running")} icon={<Activity className="h-4 w-4" />}>
              Running
            </ViewButton>
            <ViewButton active={activityView === "history"} onClick={() => setActivityView("history")} icon={<ListChecks className="h-4 w-4" />}>
              History
            </ViewButton>
            <ViewButton active={activityView === "failed"} onClick={() => setActivityView("failed")} icon={<Trash2 className="h-4 w-4" />}>
              Failed
            </ViewButton>
          </SegmentedNav>

          {activityView === "running" && <RunList runs={runningRuns} emptyText="No workflow runs are active." />}
          {activityView === "history" && <RunList runs={historyRuns} emptyText="No completed workflow runs yet." />}
          {activityView === "failed" && <RunList runs={failedRuns} emptyText="No failed workflow runs." />}
        </>
      )}
    </div>
  );
}

function DefinitionWorkspace({ definitions, onRefresh }: { definitions: WorkflowDefinition[]; onRefresh: () => void }) {
  const [editing, setEditing] = useState<WorkflowDefinition | null>(definitions[0] ?? null);

  useEffect(() => {
    if (!editing && definitions[0]) {
      setEditing(definitions[0]);
    }
    if (editing && !definitions.some((definition) => definition.id === editing.id)) {
      setEditing(definitions[0] ?? null);
    }
  }, [definitions, editing]);

  const createDraft = () => {
    setEditing({
      id: 0,
      code: `custom_workflow_${Date.now().toString().slice(-5)}`,
      displayName: "New workflow",
      description: "",
      definitionJson: JSON.stringify({ nodes: defaultNodes }),
      scope: "user",
      editable: true,
      ownerUserId: null,
      triggerCount: 0,
      createdAt: "",
      updatedAt: "",
    });
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Button size="sm" onClick={createDraft}>
          <Plus className="h-4 w-4" />
          New workflow
        </Button>
        <DefinitionList definitions={definitions} selectedId={editing?.id ?? null} onSelect={setEditing} />
      </div>
      <WorkflowEditor definition={editing} onRefresh={onRefresh} onClear={() => setEditing(null)} />
    </div>
  );
}

function WorkflowEditor({
  definition,
  onRefresh,
  onClear,
}: {
  definition: WorkflowDefinition | null;
  onRefresh: () => void;
  onClear: () => void;
}) {
  const [code, setCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<WorkflowNode[]>(defaultNodes);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!definition) return;
    setCode(definition.code);
    setDisplayName(definition.displayName);
    setDescription(definition.description);
    setNodes(parseNodes(definition.definitionJson));
    setError("");
  }, [definition]);

  if (!definition) {
    return <EmptyState text="Create or select a workflow definition." />;
  }

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = {
        code,
        displayName,
        description,
        definitionJson: JSON.stringify({ nodes }),
      };
      if (definition.id === 0) {
        await api.createWorkflowDefinition(payload);
      } else {
        await api.updateWorkflowDefinition(definition.id, payload);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (definition.id === 0) {
      onClear();
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.deleteWorkflowDefinition(definition.id);
      onClear();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Code">
            <input
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={definition.id !== 0}
            />
          </Field>
          <Field label="Name">
            <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
        </div>
        <Field label="Description">
          <textarea className="min-h-20 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Nodes</div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNodes((current) => [...current, { id: `node_${current.length + 1}`, type: "filter_candidates" }])}
            >
              <Plus className="h-4 w-4" />
              Add node
            </Button>
          </div>
          <div className="space-y-2">
            {nodes.map((node, index) => (
              <div key={`${node.id}-${index}`} className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_1.3fr_1fr_auto]">
                <input
                  className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={node.id}
                  onChange={(event) => updateNode(nodes, setNodes, index, { id: event.target.value })}
                />
                <select
                  className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  value={node.type}
                  onChange={(event) => updateNode(nodes, setNodes, index, { type: event.target.value })}
                >
                  {nodeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <input
                  className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Display name"
                  value={node.displayName ?? ""}
                  onChange={(event) => updateNode(nodes, setNodes, index, { displayName: event.target.value })}
                />
                <Button size="icon" variant="outline" aria-label="Remove node" onClick={() => setNodes((current) => current.filter((_, nodeIndex) => nodeIndex !== index))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={remove} disabled={saving}>
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduledWorkspace({
  definitions,
  triggers,
  onRefresh,
}: {
  definitions: WorkflowDefinition[];
  triggers: WorkflowTrigger[];
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<WorkflowTrigger | null>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <TriggerList triggers={triggers} onSelect={setEditing} onRefresh={onRefresh} />
      <TriggerEditor definitions={definitions} trigger={editing} onRefresh={onRefresh} onClear={() => setEditing(null)} />
    </div>
  );
}

function TriggerEditor({
  definitions,
  trigger,
  onRefresh,
  onClear,
}: {
  definitions: WorkflowDefinition[];
  trigger: WorkflowTrigger | null;
  onRefresh: () => void;
  onClear: () => void;
}) {
  const [workflowDefinitionId, setWorkflowDefinitionID] = useState(definitions[0]?.id ?? 0);
  const [displayName, setDisplayName] = useState("Scheduled workflow");
  const [triggerType, setTriggerType] = useState("schedule");
  const [enabled, setEnabled] = useState(true);
  const [scheduleJson, setScheduleJson] = useState('{"intervalMinutes":60}');
  const [configJson, setConfigJson] = useState("{}");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (trigger) {
      setWorkflowDefinitionID(trigger.workflowDefinitionId);
      setDisplayName(trigger.displayName);
      setTriggerType(trigger.triggerType);
      setEnabled(trigger.enabled);
      setScheduleJson(trigger.scheduleJson || "{}");
      setConfigJson(trigger.configJson || "{}");
    }
  }, [trigger]);

  useEffect(() => {
    if (!trigger && definitions[0]) {
      setWorkflowDefinitionID(definitions[0].id);
    }
  }, [definitions, trigger]);

  const createNew = () => {
    onClear();
    setWorkflowDefinitionID(definitions[0]?.id ?? 0);
    setDisplayName("Scheduled workflow");
    setTriggerType("schedule");
    setEnabled(true);
    setScheduleJson('{"intervalMinutes":60}');
    setConfigJson("{}");
    setError("");
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = { workflowDefinitionId, displayName, triggerType, enabled, scheduleJson, configJson, nextRunAt: null };
      if (trigger) {
        await api.updateWorkflowTrigger(trigger.id, payload);
      } else {
        await api.createWorkflowTrigger(payload);
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trigger) return;
    setSaving(true);
    setError("");
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      onClear();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold">{trigger ? "Edit scheduled trigger" : "New scheduled trigger"}</div>
          <Button size="sm" variant="outline" onClick={createNew}>
            <Plus className="h-4 w-4" />
            New
          </Button>
        </div>
        <Field label="Workflow">
          <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={workflowDefinitionId} onChange={(event) => setWorkflowDefinitionID(Number(event.target.value))}>
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label="Trigger type">
          <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={triggerType} onChange={(event) => setTriggerType(event.target.value)}>
            {triggerTypes.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled
        </label>
        <Field label="Schedule JSON">
          <textarea className="min-h-24 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={scheduleJson} onChange={(event) => setScheduleJson(event.target.value)} />
        </Field>
        <Field label="Config JSON">
          <textarea className="min-h-24 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={configJson} onChange={(event) => setConfigJson(event.target.value)} />
        </Field>
        {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          {trigger && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button onClick={save} disabled={saving || definitions.length === 0}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SegmentedNav({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">{children}</div>;
}

function ViewButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function DefinitionList({
  definitions,
  readonly = false,
  selectedId,
  onSelect,
}: {
  definitions: WorkflowDefinition[];
  readonly?: boolean;
  selectedId?: number | null;
  onSelect?: (definition: WorkflowDefinition) => void;
}) {
  return (
    <div className="grid gap-3">
      {definitions.map((definition) => (
        <Card key={definition.id} className={selectedId === definition.id ? "border-primary" : ""}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold">{definition.displayName}</div>
                <p className="mt-1 text-sm text-muted-foreground">{definition.description || "No description."}</p>
              </div>
              <Badge variant={definition.scope === "system" ? "outline" : "secondary"}>{definition.scope}</Badge>
            </div>
            <WorkflowNodeBadges definitionJson={definition.definitionJson} />
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">{definition.triggerCount} triggers</div>
              {!readonly && onSelect && (
                <Button size="sm" variant="outline" onClick={() => onSelect(definition)}>
                  Edit
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
      {definitions.length === 0 && <EmptyState text={readonly ? "No system workflow definitions are available." : "No custom workflow definitions yet."} />}
    </div>
  );
}

function TriggerList({
  triggers,
  onSelect,
  onRefresh,
}: {
  triggers: WorkflowTrigger[];
  onSelect: (trigger: WorkflowTrigger) => void;
  onRefresh: () => void;
}) {
  const toggle = async (trigger: WorkflowTrigger) => {
    await api.updateWorkflowTrigger(trigger.id, {
      workflowDefinitionId: trigger.workflowDefinitionId,
      displayName: trigger.displayName,
      triggerType: trigger.triggerType,
      enabled: !trigger.enabled,
      scheduleJson: trigger.scheduleJson,
      configJson: trigger.configJson,
      nextRunAt: trigger.nextRunAt,
    });
    onRefresh();
  };

  return (
    <div className="grid gap-3">
      {triggers.map((trigger) => (
        <Card key={trigger.id}>
          <CardContent className="flex min-h-20 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="font-semibold">{trigger.displayName}</div>
              <div className="text-sm text-muted-foreground">
                {trigger.triggerType} {"->"} {trigger.workflowCode}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => toggle(trigger)}>
                {trigger.enabled ? "Disable" : "Enable"}
              </Button>
              <Button size="sm" onClick={() => onSelect(trigger)}>
                Edit
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
      {triggers.length === 0 && <EmptyState text="No scheduled triggers are configured." />}
    </div>
  );
}

function RunList({ runs, emptyText }: { runs: WorkflowRun[]; emptyText: string }) {
  return (
    <div className="grid gap-3">
      {runs.map((run) => (
        <Card key={run.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="font-semibold">{run.displayName}</div>
                <div className="text-sm text-muted-foreground">
                  {run.triggerType} {run.triggerReason ? `- ${run.triggerReason}` : ""} at {run.createdAt}
                </div>
              </div>
              <Badge variant={run.status === "succeeded" ? "secondary" : run.status === "failed" ? "warning" : "outline"}>{run.status}</Badge>
            </div>
            <RunMetrics run={run} />
          </CardContent>
        </Card>
      ))}
      {runs.length === 0 && <EmptyState text={emptyText} />}
    </div>
  );
}

function WorkflowNodeBadges({ definitionJson }: { definitionJson: string }) {
  const nodes = useMemo(() => parseNodes(definitionJson), [definitionJson]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {nodes.map((node, index) => (
        <Badge key={`${node.id}-${index}`} variant="secondary">
          {node.type}
        </Badge>
      ))}
    </div>
  );
}

function RunMetrics({ run }: { run: WorkflowRun }) {
  const items = [
    { icon: <ListChecks className="h-3.5 w-3.5" />, label: "nodes", value: `${run.completedNodeRuns}/${run.nodeRunCount}` },
    { icon: <Database className="h-3.5 w-3.5" />, label: "jobs", value: `${run.completedJobs}/${run.jobCount}` },
    { icon: <Activity className="h-3.5 w-3.5" />, label: "candidates", value: `${run.acceptedCandidates}/${run.candidateCount}` },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">{item.icon}</span>
          <span className="font-medium">{item.value}</span>
          <span className="text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="p-5 text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

function parseNodes(definitionJson: string): WorkflowNode[] {
  try {
    const parsed = JSON.parse(definitionJson) as { nodes?: WorkflowNode[] };
    return parsed.nodes?.length ? parsed.nodes : defaultNodes;
  } catch {
    return defaultNodes;
  }
}

function updateNode(nodes: WorkflowNode[], setNodes: (nodes: WorkflowNode[]) => void, index: number, patch: Partial<WorkflowNode>) {
  setNodes(nodes.map((node, nodeIndex) => (nodeIndex === index ? { ...node, ...patch } : node)));
}

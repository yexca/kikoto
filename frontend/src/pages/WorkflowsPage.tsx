import {
  Activity,
  AlertCircle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Clock3,
  Database,
  Edit3,
  FileJson,
  FileText,
  ListChecks,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  api,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowDefinition,
  type WorkflowNodeRun,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunsPage,
  type WorkflowTrigger,
} from "@/lib/api";

type Surface = "workflows" | "activity";
type WorkflowView = "definitions" | "scheduled" | "system";
type ActivityView = "running" | "review" | "failed" | "completed" | "logs";
type RunDetailView = "overview" | "steps" | "items" | "logs";
type ModalMode = "create-workflow" | "edit-workflow" | "edit-node" | "create-trigger" | "edit-trigger" | null;

type WorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
};

type WorkflowTemplate = {
  id: string;
  label: string;
  nodes: WorkflowNode[];
};

const nodeOptions = [
  "select_local_source",
  "discover_local_files",
  "select_remote_source",
  "discover_remote_works",
  "fetch_remote_tree",
  "select_works",
  "select_media_items",
  "filter_candidates",
  "match_works",
  "plan_save",
  "sync_file_locations",
  "sync_metadata",
  "verify_files",
  "materialize_cache",
  "materialize_save",
  "cleanup_cache",
] as const;

const triggerTypes = ["startup", "schedule", "filesystem_event", "source_poll"] as const;

const workflowTemplates: WorkflowTemplate[] = [
  { id: "blank", label: "Blank", nodes: [{ id: "select", type: "select_works", displayName: "Select works" }] },
  {
    id: "metadata",
    label: "Metadata sync",
    nodes: [
      { id: "select", type: "select_works", displayName: "Select works" },
      { id: "sync", type: "sync_metadata", displayName: "Sync metadata" },
    ],
  },
  {
    id: "local",
    label: "Local scan",
    nodes: [
      { id: "select", type: "select_local_source", displayName: "Select local source" },
      { id: "discover", type: "discover_local_files", displayName: "Discover files" },
      { id: "match", type: "match_works", displayName: "Match works" },
      { id: "sync", type: "sync_file_locations", displayName: "Sync locations" },
    ],
  },
  {
    id: "remote",
    label: "Remote sync",
    nodes: [
      { id: "select", type: "select_remote_source", displayName: "Select source" },
      { id: "discover", type: "discover_remote_works", displayName: "Discover works" },
      { id: "filter", type: "filter_candidates", displayName: "Filter" },
      { id: "sync", type: "sync_file_locations", displayName: "Sync locations" },
    ],
  },
];

const manuallyRunnableSystemWorkflows: Record<string, "local_scan" | "metadata_sync"> = {
  local_library_scan: "local_scan",
  metadata_sync: "metadata_sync",
};

const sortDefinitionsForSidebar = (definitions: WorkflowDefinition[], systemMode: boolean) => {
  if (!systemMode) {
    return definitions;
  }
  return [...definitions].sort((left, right) => {
    const leftManual = manuallyRunnableSystemWorkflows[left.code] ? 0 : 1;
    const rightManual = manuallyRunnableSystemWorkflows[right.code] ? 0 : 1;
    if (leftManual !== rightManual) {
      return leftManual - rightManual;
    }
    return left.displayName.localeCompare(right.displayName);
  });
};

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
  const [runDetailView, setRunDetailView] = useState<RunDetailView>("overview");
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsPage, setRunsPage] = useState<WorkflowRunsPage>({ runs: [], page: 1, pageSize: 25, total: 0 });
  const [runPage, setRunPage] = useState(1);
  const [runQuery, setRunQuery] = useState("");
  const [selectedDefinitionId, setSelectedDefinitionID] = useState<number | null>(null);
  const [selectedTriggerId, setSelectedTriggerID] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunID] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunDetail | null>(null);
  const [selectedRunEvents, setSelectedRunEvents] = useState<WorkflowEvent[]>([]);
  const [selectedRunCandidates, setSelectedRunCandidates] = useState<WorkflowCandidate[]>([]);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingNodeIndex, setEditingNodeIndex] = useState<number | null>(null);
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);

  const refresh = () => {
    api.listWorkflowDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
    api.listWorkflowTriggers().then(setTriggers).catch(() => setTriggers([]));
  };

  const refreshRuns = (page = runPage, view = activityView, query = runQuery) => {
    api
      .listWorkflowRuns(page, runsPage.pageSize, view, query)
      .then((next) => {
        setRunsPage(next);
        setRuns(next.runs);
      })
      .catch(() => {
        setRunsPage({ runs: [], page, pageSize: runsPage.pageSize, total: 0 });
        setRuns([]);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    refreshRuns(runPage, activityView, runQuery);
  }, [activityView, runPage]);

  const userDefinitions = definitions.filter((definition) => definition.scope === "user");
  const systemDefinitions = definitions.filter((definition) => definition.scope === "system");
  const scheduledTriggers = triggers.filter((trigger) => trigger.triggerType !== "manual");
  const visibleDefinitions = workflowView === "system" ? systemDefinitions : userDefinitions;
  const visibleRuns = runs;

  const selectedDefinition = useMemo(() => {
    const pool = workflowView === "system" ? systemDefinitions : definitions;
    return pool.find((definition) => definition.id === selectedDefinitionId) ?? pool[0] ?? null;
  }, [definitions, selectedDefinitionId, systemDefinitions, workflowView]);

  const selectedTrigger = scheduledTriggers.find((trigger) => trigger.id === selectedTriggerId) ?? scheduledTriggers[0] ?? null;
  const scheduledDefinition = definitions.find((definition) => definition.id === selectedTrigger?.workflowDefinitionId) ?? null;
  const selectedRunSummary = visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0] ?? null;
  const selectedSystemRunKind =
    workflowView === "system" && selectedDefinition ? manuallyRunnableSystemWorkflows[selectedDefinition.code] : undefined;

  useEffect(() => {
    if (!selectedDefinitionId && visibleDefinitions[0]) {
      setSelectedDefinitionID(visibleDefinitions[0].id);
    }
  }, [selectedDefinitionId, visibleDefinitions]);

  useEffect(() => {
    if (!selectedTriggerId && scheduledTriggers[0]) {
      setSelectedTriggerID(scheduledTriggers[0].id);
    }
  }, [scheduledTriggers, selectedTriggerId]);

  useEffect(() => {
    if (!selectedRunSummary) {
      setSelectedRun(null);
      setSelectedRunEvents([]);
      setSelectedRunCandidates([]);
      return;
    }
    setSelectedRunID(selectedRunSummary.id);
    api.getWorkflowRun(selectedRunSummary.id).then(setSelectedRun).catch(() => setSelectedRun(null));
    api.listWorkflowRunEvents(selectedRunSummary.id).then(setSelectedRunEvents).catch(() => setSelectedRunEvents([]));
    api.listWorkflowRunCandidates(selectedRunSummary.id).then(setSelectedRunCandidates).catch(() => setSelectedRunCandidates([]));
  }, [selectedRunSummary?.id]);

  const runLocalScan = async () => {
    setIsRunningScan(true);
    try {
      await api.runLocalScan();
      refresh();
      setActivityView("completed");
      setRunPage(1);
      refreshRuns(1, "completed", runQuery);
    } finally {
      setIsRunningScan(false);
    }
  };

  const runMetadataSync = async () => {
    setIsSyncingMetadata(true);
    try {
      await api.runDLsiteSync();
      refresh();
      setActivityView("completed");
      setRunPage(1);
      refreshRuns(1, "completed", runQuery);
    } finally {
      setIsSyncingMetadata(false);
    }
  };

  const refreshSelectedRunReview = async () => {
    if (!selectedRunSummary) return;
    const [nextCandidates, nextEvents] = await Promise.all([
      api.listWorkflowRunCandidates(selectedRunSummary.id).catch(() => []),
      api.listWorkflowRunEvents(selectedRunSummary.id).catch(() => []),
    ]);
    setSelectedRunCandidates(nextCandidates);
    setSelectedRunEvents(nextEvents);
    refreshRuns(runPage, activityView, runQuery);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{surface === "activity" ? "Activity" : "Workflows"}</h2>
          <p className="text-sm text-muted-foreground">
            {surface === "activity" ? "Inspect runs by node state and failure point." : "Build workflows on the left; inspect and edit their node pipeline on the right."}
          </p>
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

          {workflowView === "scheduled" ? (
            <Workbench
              left={
                <TriggerSidebar
                  triggers={scheduledTriggers}
                  selectedId={selectedTrigger?.id ?? null}
                  onSelect={(trigger) => setSelectedTriggerID(trigger.id)}
                  onCreate={() => setModalMode("create-trigger")}
                />
              }
              right={
                <WorkflowDetail
                  definition={scheduledDefinition}
                  trigger={selectedTrigger}
                  readonly
                  onEditTrigger={() => setModalMode("edit-trigger")}
                  onEditDefinition={() => undefined}
                  onEditNode={() => undefined}
                />
              }
            />
          ) : (
            <Workbench
              left={
                <DefinitionSidebar
                  definitions={visibleDefinitions}
                  selectedId={selectedDefinition?.id ?? null}
                  canCreate={workflowView === "definitions"}
                  systemMode={workflowView === "system"}
                  onSelect={(definition) => setSelectedDefinitionID(definition.id)}
                  onCreate={() => setModalMode("create-workflow")}
                />
              }
              right={
                <WorkflowDetail
                  definition={selectedDefinition}
                  readonly={workflowView === "system" || !selectedDefinition?.editable}
                  systemRunKind={selectedSystemRunKind}
                  isRunningAction={selectedSystemRunKind === "local_scan" ? isRunningScan : isSyncingMetadata}
                  canRunAction={selectedSystemRunKind === "local_scan" ? canRun : selectedSystemRunKind === "metadata_sync" ? canSyncMetadata : false}
                  onRunSystemAction={
                    selectedSystemRunKind === "local_scan"
                      ? runLocalScan
                      : selectedSystemRunKind === "metadata_sync"
                        ? runMetadataSync
                        : undefined
                  }
                  onEditDefinition={() => setModalMode("edit-workflow")}
                  onEditNode={(index) => {
                    setEditingNodeIndex(index);
                    setModalMode("edit-node");
                  }}
                />
              }
            />
          )}
        </>
      ) : (
        <>
          <SegmentedNav>
            <ViewButton active={activityView === "running"} onClick={() => switchActivityView("running", setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<Activity className="h-4 w-4" />}>
              Running
            </ViewButton>
            <ViewButton active={activityView === "review"} onClick={() => switchActivityView("review", setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<FileJson className="h-4 w-4" />}>
              Review
            </ViewButton>
            <ViewButton active={activityView === "failed"} onClick={() => switchActivityView("failed", setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<AlertCircle className="h-4 w-4" />}>
              Failed
            </ViewButton>
            <ViewButton active={activityView === "completed"} onClick={() => switchActivityView("completed", setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<ListChecks className="h-4 w-4" />}>
              Completed
            </ViewButton>
            <ViewButton active={activityView === "logs"} onClick={() => switchActivityView("logs", setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<FileText className="h-4 w-4" />}>
              Logs
            </ViewButton>
          </SegmentedNav>
          <ActivityToolbar
            query={runQuery}
            page={runsPage.page}
            pageSize={runsPage.pageSize}
            total={runsPage.total}
            onQueryChange={setRunQuery}
            onSearch={() => {
              setRunPage(1);
              setSelectedRunID(null);
              refreshRuns(1, activityView, runQuery);
            }}
            onPrevious={() => {
              setSelectedRunID(null);
              setRunPage(Math.max(1, runPage - 1));
            }}
            onNext={() => {
              setSelectedRunID(null);
              setRunPage(runPage + 1);
            }}
          />
          <Workbench
            left={<RunSidebar runs={visibleRuns} selectedId={selectedRunSummary?.id ?? null} onSelect={(run) => setSelectedRunID(run.id)} />}
            right={<RunDetail run={selectedRun ?? selectedRunSummary} events={selectedRunEvents} candidates={selectedRunCandidates} view={runDetailView} onViewChange={setRunDetailView} onCandidateUpdate={refreshSelectedRunReview} />}
          />
        </>
      )}

      {modalMode === "create-workflow" && (
        <WorkflowModal
          title="New workflow"
          definition={null}
          onClose={() => setModalMode(null)}
          onSaved={(definition) => {
            setSelectedDefinitionID(definition.id);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-workflow" && selectedDefinition && (
        <WorkflowModal
          title="Edit workflow"
          definition={selectedDefinition}
          onClose={() => setModalMode(null)}
          onSaved={(definition) => {
            setSelectedDefinitionID(definition.id);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-node" && selectedDefinition && editingNodeIndex !== null && (
        <NodeModal
          definition={selectedDefinition}
          nodeIndex={editingNodeIndex}
          onClose={() => setModalMode(null)}
          onSaved={() => {
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "create-trigger" && (
        <TriggerModal
          definitions={definitions}
          trigger={null}
          onClose={() => setModalMode(null)}
          onSaved={(trigger) => {
            setSelectedTriggerID(trigger.id);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-trigger" && selectedTrigger && (
        <TriggerModal
          definitions={definitions}
          trigger={selectedTrigger}
          onClose={() => setModalMode(null)}
          onSaved={(trigger) => {
            setSelectedTriggerID(trigger.id);
            setModalMode(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Workbench({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return <div className="grid items-start gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">{left}{right}</div>;
}

function DefinitionSidebar({
  definitions,
  selectedId,
  canCreate,
  systemMode = false,
  onSelect,
  onCreate,
}: {
  definitions: WorkflowDefinition[];
  selectedId: number | null;
  canCreate: boolean;
  systemMode?: boolean;
  onSelect: (definition: WorkflowDefinition) => void;
  onCreate: () => void;
}) {
  const sortedDefinitions = sortDefinitionsForSidebar(definitions, systemMode);

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <div>
            <div className="text-sm font-semibold">{systemMode ? "System workflow catalog" : "Workflow list"}</div>
            {systemMode && <div className="text-xs text-muted-foreground">Built-in workflows are read-only.</div>}
          </div>
          {canCreate && (
            <Button size="sm" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              New
            </Button>
          )}
        </div>
        <div className="space-y-2">
          {sortedDefinitions.map((definition) => {
            const systemRunKind = manuallyRunnableSystemWorkflows[definition.code];
            return (
              <button
                key={definition.id}
                className={`w-full rounded-md border p-3 text-left transition-colors ${
                  selectedId === definition.id ? "border-primary bg-secondary" : "bg-card hover:bg-muted"
                }`}
                onClick={() => onSelect(definition)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{definition.displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">{definition.code}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Badge variant={definition.scope === "system" ? "outline" : "secondary"}>{definition.scope}</Badge>
                    {definition.scope === "system" && (
                      <Badge variant={systemRunKind ? "default" : "secondary"}>{systemRunKind ? "Manual" : "Read only"}</Badge>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>{parseNodes(definition.definitionJson).length} nodes</span>
                  <span>{definition.triggerCount} triggers</span>
                  {definition.scope === "system" && (
                    <span>{systemRunKind ? "manual action available" : "triggered by app actions"}</span>
                  )}
                </div>
              </button>
            );
          })}
          {definitions.length === 0 && <EmptyPanel text="No workflows here yet." />}
        </div>
      </CardContent>
    </Card>
  );
}

function TriggerSidebar({
  triggers,
  selectedId,
  onSelect,
  onCreate,
}: {
  triggers: WorkflowTrigger[];
  selectedId: number | null;
  onSelect: (trigger: WorkflowTrigger) => void;
  onCreate: () => void;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="text-sm font-semibold">Scheduled</div>
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />
            New
          </Button>
        </div>
        <div className="space-y-2">
          {triggers.map((trigger) => (
            <button
              key={trigger.id}
              className={`w-full rounded-md border p-3 text-left transition-colors ${
                selectedId === trigger.id ? "border-primary bg-secondary" : "bg-card hover:bg-muted"
              }`}
              onClick={() => onSelect(trigger)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{trigger.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">{trigger.triggerType} · {trigger.workflowCode}</div>
                </div>
                <StatusBadge status={trigger.enabled ? "enabled" : "disabled"} />
              </div>
              <div className="mt-2 text-xs text-muted-foreground">{trigger.lastSuccessAt ? `Last success ${trigger.lastSuccessAt}` : "No successful run yet"}</div>
            </button>
          ))}
          {triggers.length === 0 && <EmptyPanel text="No scheduled triggers yet." />}
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityToolbar({
  query,
  page,
  pageSize,
  total,
  onQueryChange,
  onSearch,
  onPrevious,
  onNext,
}: {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 md:flex-row md:items-center md:justify-between">
      <label className="flex h-9 min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-sm md:w-80">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none"
          value={query}
          placeholder="Search runs"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSearch();
          }}
        />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground md:justify-end">
        <span>
          Page {page} / {totalPages} · {total} runs
        </span>
        <div className="flex gap-1">
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page <= 1} onClick={onPrevious} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" className="h-8 w-8" disabled={page >= totalPages} onClick={onNext} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RunSidebar({ runs, selectedId, onSelect }: { runs: WorkflowRun[]; selectedId: number | null; onSelect: (run: WorkflowRun) => void }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between px-1 text-sm">
          <span className="font-semibold">Runs</span>
          <span className="text-muted-foreground">{runs.length} shown</span>
        </div>
        <div className="divide-y rounded-md border">
          {runs.map((run) => (
            <button
              key={run.id}
              className={`w-full p-3 text-left transition-colors ${
                selectedId === run.id ? "bg-secondary" : "bg-card hover:bg-muted"
              }`}
              onClick={() => onSelect(run)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{run.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">{run.workflowCode}</div>
                </div>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatRunTime(run)}</span>
                <span>{run.completedNodeRuns}/{run.nodeRunCount} nodes</span>
                {run.failedNodeRuns > 0 && <span className="text-destructive">{run.failedNodeRuns} failed</span>}
                {run.skippedNodeRuns > 0 && <span>{run.skippedNodeRuns} skipped</span>}
                {reviewCount(run) > 0 && <span className="text-primary">{reviewCount(run)} review</span>}
              </div>
            </button>
          ))}
        </div>
        {runs.length === 0 && <EmptyPanel text="No runs in this view." />}
      </CardContent>
    </Card>
  );
}

function WorkflowDetail({
  definition,
  trigger,
  readonly,
  systemRunKind,
  isRunningAction,
  canRunAction,
  onRunSystemAction,
  onEditDefinition,
  onEditTrigger,
  onEditNode,
}: {
  definition: WorkflowDefinition | null;
  trigger?: WorkflowTrigger | null;
  readonly: boolean;
  systemRunKind?: "local_scan" | "metadata_sync";
  isRunningAction?: boolean;
  canRunAction?: boolean;
  onRunSystemAction?: () => Promise<void>;
  onEditDefinition: () => void;
  onEditTrigger?: () => void;
  onEditNode: (index: number) => void;
}) {
  if (!definition) {
    return <EmptyPanel text="Select a workflow to inspect its node pipeline." />;
  }
  const nodes = parseNodes(definition.definitionJson);
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{definition.displayName}</h3>
              <Badge variant={definition.scope === "system" ? "outline" : "secondary"}>{definition.scope}</Badge>
              {trigger && <StatusBadge status={trigger.enabled ? "enabled" : "disabled"} />}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{definition.description || "No description."}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{definition.code}</span>
              <span>{nodes.length} nodes</span>
              <span>{definition.triggerCount} triggers</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {trigger && onEditTrigger && (
              <Button size="sm" variant="outline" onClick={onEditTrigger}>
                <CalendarClock className="h-4 w-4" />
                Edit trigger
              </Button>
            )}
            {!readonly && (
              <Button size="sm" onClick={onEditDefinition}>
                <Edit3 className="h-4 w-4" />
                Edit workflow
              </Button>
            )}
            {definition.scope === "system" && systemRunKind && onRunSystemAction && (
              <Button size="sm" onClick={() => void onRunSystemAction()} disabled={isRunningAction || !canRunAction}>
                <Play className="h-4 w-4" />
                {isRunningAction ? "Running" : systemRunKind === "local_scan" ? "Run local scan" : "Sync metadata"}
              </Button>
            )}
          </div>
        </div>

        {definition.scope === "system" && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {systemRunKind
              ? "This system workflow is read-only, but it exposes a manual action."
              : "This system workflow is read-only and is triggered by application actions."}
          </div>
        )}
        {trigger && <TriggerSummary trigger={trigger} />}
        <NodePipeline nodes={nodes} readonly={readonly} onEditNode={onEditNode} />
      </CardContent>
    </Card>
  );
}

function RunDetail({
  run,
  events,
  candidates,
  view,
  onViewChange,
  onCandidateUpdate,
}: {
  run: WorkflowRunDetail | WorkflowRun | null;
  events: WorkflowEvent[];
  candidates: WorkflowCandidate[];
  view: RunDetailView;
  onViewChange: (view: RunDetailView) => void;
  onCandidateUpdate: () => Promise<void>;
}) {
  if (!run) {
    return <EmptyPanel text="Select a run to inspect execution by node." />;
  }
  const nodeRuns = "nodeRuns" in run ? run.nodeRuns : [];
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{run.displayName}</h3>
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {run.triggerType} {run.triggerReason ? `· ${run.triggerReason}` : ""} · {run.createdAt}
            </p>
          </div>
          <RunMetrics run={run} />
        </div>
        <SegmentedNav>
          <ViewButton active={view === "overview"} onClick={() => onViewChange("overview")} icon={<Activity className="h-4 w-4" />}>
            Overview
          </ViewButton>
          <ViewButton active={view === "steps"} onClick={() => onViewChange("steps")} icon={<Workflow className="h-4 w-4" />}>
            Steps
          </ViewButton>
          <ViewButton active={view === "items"} onClick={() => onViewChange("items")} icon={<FileJson className="h-4 w-4" />}>
            Items
          </ViewButton>
          <ViewButton active={view === "logs"} onClick={() => onViewChange("logs")} icon={<FileText className="h-4 w-4" />}>
            Logs
          </ViewButton>
        </SegmentedNav>
        {view === "overview" ? (
          <RunOverview run={run} nodeRuns={nodeRuns} />
        ) : view === "steps" ? (
          nodeRuns.length > 0 ? <RunNodePipeline nodes={nodeRuns} /> : <EmptyPanel text="This run has no node detail yet." />
        ) : view === "items" ? (
          <RunItems run={run} nodeRuns={nodeRuns} candidates={candidates} onCandidateUpdate={onCandidateUpdate} />
        ) : (
          <RunLogs run={run} nodeRuns={nodeRuns} events={events} />
        )}
      </CardContent>
    </Card>
  );
}

function RunOverview({ run, nodeRuns }: { run: WorkflowRunDetail | WorkflowRun; nodeRuns: WorkflowNodeRun[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-sm font-semibold">Summary</div>
        <JsonPreview value={run.summaryJson} empty="No summary recorded." />
      </div>
      <div className="grid content-start gap-2">
        <SummaryCell label="Started" value={run.startedAt || "not recorded"} />
        <SummaryCell label="Finished" value={run.finishedAt || "not finished"} />
        <SummaryCell label="Trigger" value={`${run.triggerType}${run.triggerReason ? ` · ${run.triggerReason}` : ""}`} />
        <SummaryCell label="Review signals" value={`${reviewCount(run)} pending, ${run.skippedNodeRuns + run.skippedJobs} skipped`} />
      </div>
      {nodeRuns.some((node) => node.errorMessage) && (
        <div className="lg:col-span-2">
          <ErrorPanel error={nodeRuns.find((node) => node.errorMessage)?.errorMessage ?? ""} />
        </div>
      )}
    </div>
  );
}

function RunItems({
  run,
  nodeRuns,
  candidates,
  onCandidateUpdate,
}: {
  run: WorkflowRunDetail | WorkflowRun;
  nodeRuns: WorkflowNodeRun[];
  candidates: WorkflowCandidate[];
  onCandidateUpdate: () => Promise<void>;
}) {
  const interestingNodes = nodeRuns.filter((node) => node.status !== "succeeded" || node.errorMessage || hasNonEmptyJSON(node.outputJson));
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Metric icon={<FileJson className="h-3.5 w-3.5" />} label="pending review" value={`${reviewCount(run)}`} />
        <Metric icon={<AlertCircle className="h-3.5 w-3.5" />} label="failed items" value={`${run.failedNodeRuns + run.failedJobs}`} />
        <Metric icon={<Clock3 className="h-3.5 w-3.5" />} label="skipped items" value={`${run.skippedNodeRuns + run.skippedJobs}`} />
      </div>
      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Candidates</div>
          <div className="divide-y rounded-md border">
            {candidates.map((candidate) => (
              <div key={candidate.id} className="grid gap-2 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{candidate.externalKey || candidate.type}</div>
                    <div className="text-xs text-muted-foreground">{candidate.type} · updated {candidate.updatedAt}</div>
                  </div>
                  <StatusBadge status={candidate.status} />
                </div>
                <JsonPreview value={candidate.payloadJson} empty="No candidate payload." compact />
                {hasNonEmptyJSON(candidate.decisionJson) && <JsonPreview value={candidate.decisionJson} empty="No decision payload." compact />}
                {candidateNeedsReview(candidate) && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await api.updateWorkflowCandidate(candidate.id, { status: "resolved" });
                        await onCandidateUpdate();
                      }}
                    >
                      Mark resolved
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        await api.updateWorkflowCandidate(candidate.id, { status: "ignored" });
                        await onCandidateUpdate();
                      }}
                    >
                      Ignore
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="divide-y rounded-md border">
        {interestingNodes.map((node) => (
          <div key={node.id} className="grid gap-2 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">{node.displayName || node.nodeId}</div>
                <div className="text-xs text-muted-foreground">{node.nodeType}</div>
              </div>
              <StatusBadge status={node.status} />
            </div>
            {node.errorMessage && <div className="text-sm text-destructive">{node.errorMessage}</div>}
            <JsonPreview value={node.outputJson} empty="No output payload." compact />
          </div>
        ))}
        {interestingNodes.length === 0 && <div className="p-3 text-sm text-muted-foreground">No reviewable items recorded for this run.</div>}
      </div>
    </div>
  );
}

function RunLogs({ run, nodeRuns, events }: { run: WorkflowRunDetail | WorkflowRun; nodeRuns: WorkflowNodeRun[]; events: WorkflowEvent[] }) {
  const entries = events.length > 0 ? events.map((event) => ({
    time: event.createdAt,
    level: event.level,
    message: event.message,
    detail: summarizeJSON(event.detailJson),
    type: event.eventType,
  })) : [
    { time: run.createdAt, level: "info", message: `Run created: ${run.displayName}`, detail: run.triggerReason },
    ...nodeRuns.map((node) => ({
      time: node.startedAt || node.createdAt,
      level: node.status === "failed" ? "error" : node.status === "skipped" || node.status === "partial" ? "warn" : "info",
      message: `${node.displayName || node.nodeId} ${node.status}`,
      detail: node.errorMessage || summarizeJSON(node.outputJson),
      type: "node.derived",
    })),
  ];
  return (
    <div className="divide-y rounded-md border bg-background">
      {entries.map((entry, index) => (
        <div key={`${entry.time}-${index}`} className="grid gap-1 p-3 text-sm md:grid-cols-[150px_70px_minmax(0,1fr)]">
          <div className="text-xs text-muted-foreground">{entry.time || "unknown time"}</div>
          <div className={entry.level === "error" ? "text-destructive" : entry.level === "warn" ? "text-primary" : "text-muted-foreground"}>{entry.level}</div>
          <div className="min-w-0">
            <div className="font-medium">{entry.message}</div>
            {"type" in entry && entry.type && <div className="text-xs text-muted-foreground">{entry.type}</div>}
            {entry.detail && <div className="mt-1 break-words text-xs text-muted-foreground">{entry.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function NodePipeline({ nodes, readonly, onEditNode }: { nodes: WorkflowNode[]; readonly: boolean; onEditNode: (index: number) => void }) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-stretch gap-3">
        {nodes.map((node, index) => (
          <div key={`${node.id}-${index}`} className="flex items-center gap-3">
            <NodeCard
              title={node.displayName || node.id}
              subtitle={node.type}
              status="idle"
              readonly={readonly}
              onEdit={() => onEditNode(index)}
              onDoubleClick={() => !readonly && onEditNode(index)}
            />
            {index < nodes.length - 1 && <Connector />}
          </div>
        ))}
      </div>
    </div>
  );
}

function RunNodePipeline({ nodes }: { nodes: WorkflowNodeRun[] }) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-stretch gap-3">
        {nodes.map((node, index) => (
          <div key={node.id} className="flex items-center gap-3">
            <NodeCard title={node.displayName || node.nodeId} subtitle={node.nodeType} status={node.status} error={node.errorMessage} readonly />
            {index < nodes.length - 1 && <Connector active={node.status === "succeeded"} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeCard({
  title,
  subtitle,
  status,
  error,
  readonly,
  onEdit,
  onDoubleClick,
}: {
  title: string;
  subtitle: string;
  status: string;
  error?: string;
  readonly: boolean;
  onEdit?: () => void;
  onDoubleClick?: () => void;
}) {
  const tone = nodeTone(status);
  return (
    <div className={`relative grid min-h-32 w-56 content-between rounded-md border p-3 ${tone.card}`} onDoubleClick={onDoubleClick}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="mt-1 break-all text-xs text-muted-foreground">{subtitle}</div>
        </div>
        {!readonly && (
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Edit node" onClick={onEdit}>
            <Edit3 className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="space-y-2">
        {error && <div className="line-clamp-2 text-xs text-destructive">{error}</div>}
        <div className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${tone.badge}`}>
          {tone.icon}
          {status}
        </div>
      </div>
    </div>
  );
}

function Connector({ active = false }: { active?: boolean }) {
  return <div className={`h-0.5 w-10 rounded-full ${active ? "bg-primary" : "bg-border"}`} />;
}

function TriggerSummary({ trigger }: { trigger: WorkflowTrigger }) {
  return (
    <div className="grid gap-3 rounded-md border bg-muted/40 p-3 md:grid-cols-4">
      <SummaryCell label="Type" value={trigger.triggerType} />
      <SummaryCell label="Next" value={trigger.nextRunAt ?? "not scheduled"} />
      <SummaryCell label="Last run" value={trigger.lastRunAt ?? "never"} />
      <SummaryCell label="Last error" value={trigger.lastErrorMessage || "none"} />
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function WorkflowModal({
  title,
  definition,
  onClose,
  onSaved,
}: {
  title: string;
  definition: WorkflowDefinition | null;
  onClose: () => void;
  onSaved: (definition: WorkflowDefinition) => void;
}) {
  const [code, setCode] = useState(definition?.code ?? `custom_workflow_${Date.now().toString().slice(-5)}`);
  const [displayName, setDisplayName] = useState(definition?.displayName ?? "New workflow");
  const [description, setDescription] = useState(definition?.description ?? "");
  const [templateId, setTemplateID] = useState(workflowTemplates[1].id);
  const [nodes, setNodes] = useState<WorkflowNode[]>(definition ? parseNodes(definition.definitionJson) : workflowTemplates[1].nodes);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = { code, displayName, description, definitionJson: JSON.stringify({ nodes }) };
      const saved = definition ? await api.updateWorkflowDefinition(definition.id, payload) : await api.createWorkflowDefinition(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!definition) return;
    setSaving(true);
    try {
      await api.deleteWorkflowDefinition(definition.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Code">
            <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60" value={code} disabled={!!definition} onChange={(event) => setCode(event.target.value)} />
          </Field>
          <Field label="Name">
            <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
        </div>
        {!definition && (
          <Field label="Template">
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={templateId}
              onChange={(event) => {
                setTemplateID(event.target.value);
                setNodes(workflowTemplates.find((template) => template.id === event.target.value)?.nodes ?? workflowTemplates[0].nodes);
              }}
            >
              {workflowTemplates.map((template) => (
                <option key={template.id} value={template.id}>{template.label}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Description">
          <textarea className="min-h-20 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Nodes</div>
            <Button size="sm" variant="outline" onClick={() => setNodes((current) => [...current, { id: `node_${current.length + 1}`, type: "filter_candidates" }])}>
              <Plus className="h-4 w-4" />
              Add node
            </Button>
          </div>
          <div className="grid gap-2">
            {nodes.map((node, index) => (
              <NodeInlineEditor key={`${node.id}-${index}`} node={node} onChange={(patch) => setNodes(updateNodes(nodes, index, patch))} onRemove={() => setNodes(nodes.filter((_, nodeIndex) => nodeIndex !== index))} />
            ))}
          </div>
        </div>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2">
          {definition && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function NodeModal({
  definition,
  nodeIndex,
  onClose,
  onSaved,
}: {
  definition: WorkflowDefinition;
  nodeIndex: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const nodes = parseNodes(definition.definitionJson);
  const [node, setNode] = useState<WorkflowNode>(nodes[nodeIndex] ?? { id: "node", type: "filter_candidates" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const nextNodes = updateNodes(nodes, nodeIndex, node);
      await api.updateWorkflowDefinition(definition.id, {
        code: definition.code,
        displayName: definition.displayName,
        description: definition.description,
        definitionJson: JSON.stringify({ nodes: nextNodes }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit node" onClose={onClose}>
      <div className="space-y-3">
        <NodeInlineEditor node={node} onChange={(patch) => setNode({ ...node, ...patch })} />
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TriggerModal({
  definitions,
  trigger,
  onClose,
  onSaved,
}: {
  definitions: WorkflowDefinition[];
  trigger: WorkflowTrigger | null;
  onClose: () => void;
  onSaved: (trigger: WorkflowTrigger) => void;
}) {
  const [workflowDefinitionId, setWorkflowDefinitionID] = useState(trigger?.workflowDefinitionId ?? definitions[0]?.id ?? 0);
  const [displayName, setDisplayName] = useState(trigger?.displayName ?? "Scheduled workflow");
  const [triggerType, setTriggerType] = useState(trigger?.triggerType ?? "schedule");
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [scheduleJson, setScheduleJson] = useState(trigger?.scheduleJson ?? '{"intervalMinutes":60}');
  const [configJson, setConfigJson] = useState(trigger?.configJson ?? "{}");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = { workflowDefinitionId, displayName, triggerType, enabled, scheduleJson, configJson, nextRunAt: null };
      const saved = trigger ? await api.updateWorkflowTrigger(trigger.id, payload) : await api.createWorkflowTrigger(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trigger) return;
    setSaving(true);
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={trigger ? "Edit scheduled trigger" : "New scheduled trigger"} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="Workflow">
          <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={workflowDefinitionId} onChange={(event) => setWorkflowDefinitionID(Number(event.target.value))}>
            {definitions.map((definition) => (
              <option key={definition.id} value={definition.id}>{definition.displayName}</option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Trigger type">
            <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={triggerType} onChange={(event) => setTriggerType(event.target.value)}>
              {triggerTypes.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled
          </label>
        </div>
        <Field label="Schedule JSON">
          <textarea className="min-h-24 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={scheduleJson} onChange={(event) => setScheduleJson(event.target.value)} />
        </Field>
        <Field label="Config JSON">
          <textarea className="min-h-24 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={configJson} onChange={(event) => setConfigJson(event.target.value)} />
        </Field>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2">
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
      </div>
    </Modal>
  );
}

function NodeInlineEditor({ node, onChange, onRemove }: { node: WorkflowNode; onChange: (patch: Partial<WorkflowNode>) => void; onRemove?: () => void }) {
  return (
    <div className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_1.3fr_1fr_auto]">
      <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={node.id} onChange={(event) => onChange({ id: event.target.value })} />
      <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={node.type} onChange={(event) => onChange({ type: event.target.value })}>
        {nodeOptions.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Display name" value={node.displayName ?? ""} onChange={(event) => onChange({ displayName: event.target.value })} />
      {onRemove && (
        <Button size="icon" variant="outline" aria-label="Remove node" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4 backdrop-blur-sm">
      <div className="max-h-[86vh] w-full max-w-3xl overflow-auto rounded-lg border bg-card shadow-xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="font-semibold">{title}</div>
          <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function SegmentedNav({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">{children}</div>;
}

function ViewButton({ active, icon, children, onClick }: { active: boolean; icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
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

function RunMetrics({ run }: { run: WorkflowRun }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Metric icon={<ListChecks className="h-3.5 w-3.5" />} label="nodes" value={`${run.completedNodeRuns}/${run.nodeRunCount}`} />
      <Metric icon={<Database className="h-3.5 w-3.5" />} label="jobs" value={`${run.completedJobs}/${run.jobCount}`} />
      <Metric icon={<Activity className="h-3.5 w-3.5" />} label="review" value={`${reviewCount(run)}`} />
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-medium">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "failed" || status === "partial" || status === "disabled"
      ? "warning"
      : status === "succeeded" || status === "enabled"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="p-5 text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

function ErrorPanel({ error }: { error: string }) {
  return <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>;
}

function JsonPreview({ value, empty, compact = false }: { value: string; empty: string; compact?: boolean }) {
  const summary = summarizeJSON(value);
  if (!summary) {
    return <div className="mt-2 text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <pre className={`mt-2 overflow-auto rounded-md border bg-background p-3 text-xs text-muted-foreground ${compact ? "max-h-32" : "max-h-56"}`}>
      {summary}
    </pre>
  );
}

function parseNodes(definitionJson: string): WorkflowNode[] {
  try {
    const parsed = JSON.parse(definitionJson) as { nodes?: WorkflowNode[] };
    return parsed.nodes?.length ? parsed.nodes : workflowTemplates[0].nodes;
  } catch {
    return workflowTemplates[0].nodes;
  }
}

function updateNodes(nodes: WorkflowNode[], index: number, patch: Partial<WorkflowNode>) {
  return nodes.map((node, nodeIndex) => (nodeIndex === index ? { ...node, ...patch } : node));
}

function switchActivityView(
  view: ActivityView,
  setActivityView: (view: ActivityView) => void,
  setRunPage: (page: number) => void,
  setSelectedRunID: (id: number | null) => void,
  setRunDetailView: (view: RunDetailView) => void,
) {
  setActivityView(view);
  setRunPage(1);
  setSelectedRunID(null);
  setRunDetailView(view === "logs" ? "logs" : view === "review" ? "items" : "overview");
}

function reviewCount(run: WorkflowRun) {
  return run.pendingCandidates + run.skippedNodeRuns + run.skippedJobs + (run.status === "partial" || run.status === "skipped" ? 1 : 0);
}

function candidateNeedsReview(candidate: WorkflowCandidate) {
  return !["accepted", "rejected", "ignored", "resolved"].includes(candidate.status);
}

function formatRunTime(run: WorkflowRun) {
  return run.finishedAt || run.startedAt || run.createdAt;
}

function hasNonEmptyJSON(value: string) {
  return Boolean(summarizeJSON(value));
}

function summarizeJSON(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}" || trimmed === "null") {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function nodeTone(status: string) {
  if (status === "failed") {
    return {
      card: "border-destructive/40 bg-destructive/5",
      badge: "bg-destructive text-destructive-foreground",
      icon: <AlertCircle className="h-3.5 w-3.5" />,
    };
  }
  if (status === "partial") {
    return {
      card: "border-primary/40 bg-primary/5",
      badge: "bg-primary text-primary-foreground",
      icon: <AlertCircle className="h-3.5 w-3.5" />,
    };
  }
  if (status === "skipped") {
    return {
      card: "border-muted bg-muted/30",
      badge: "bg-muted text-muted-foreground",
      icon: <FileJson className="h-3.5 w-3.5" />,
    };
  }
  if (status === "running" || status === "queued") {
    return {
      card: "border-primary/40 bg-secondary",
      badge: "bg-primary text-primary-foreground",
      icon: <Clock3 className="h-3.5 w-3.5" />,
    };
  }
  if (status === "succeeded") {
    return {
      card: "border-primary/30 bg-card",
      badge: "bg-secondary text-secondary-foreground",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    };
  }
  return {
    card: "bg-card",
    badge: "bg-muted text-muted-foreground",
    icon: <FileJson className="h-3.5 w-3.5" />,
  };
}

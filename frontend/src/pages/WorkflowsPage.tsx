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
  Tag,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  api,
  type LibrarySource,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowDefinition,
  type WorkflowNodeType,
  type WorkflowNodeRun,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunsPage,
  type WorkflowTrigger,
} from "@/lib/api";

type Surface = "workflows" | "activity";
type WorkflowView = "definitions" | "scheduled" | "system";
type DefinitionView = Exclude<WorkflowView, "scheduled">;
type ActivityView = "running" | "review" | "failed" | "completed" | "logs";
type RunDetailView = "overview" | "steps" | "items" | "logs";
type ModalMode = "create-workflow" | "edit-workflow" | "edit-node" | "create-trigger" | "edit-trigger" | null;

type WorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
};

type WorkflowTemplate = {
  id: string;
  label: string;
  nodes: WorkflowNode[];
};

const fallbackNodeTypes: WorkflowNodeType[] = [
  { type: "select_works", phase: "target", displayName: "Select works", description: "Choose known works.", userVisible: true, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
  { type: "select_ranking", phase: "target", displayName: "Configure ranking", description: "Choose a ranking period.", userVisible: false, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
  { type: "discover_provider_ranking", phase: "discover", displayName: "Discover provider ranking", description: "Fetch an ordered provider ranking.", userVisible: false, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
  { type: "filter_candidates", phase: "filter", displayName: "Filter candidates", description: "Filter workflow candidates.", userVisible: true, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
  { type: "sync_metadata", phase: "commit", displayName: "Sync metadata", description: "Persist metadata.", userVisible: true, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
  { type: "assign_user_tags", phase: "commit", displayName: "Assign user tags", description: "Append user-owned tags.", userVisible: false, configSchema: "{}", inputSchema: "{}", outputSchema: "{}" },
];

const phaseOrder = ["target", "discover", "filter", "match", "plan", "execute", "verify", "commit"] as const;

const triggerTypes = ["startup", "schedule", "filesystem_event", "source_poll"] as const;
const activityViews: ActivityView[] = ["running", "review", "failed", "completed", "logs"];
const workflowViewStorageKey = "kikoto.workflows.view";
const workflowDefinitionStoragePrefix = "kikoto.workflows.definition.";
const workflowTriggerStorageKey = "kikoto.workflows.trigger";

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

type SystemRunKind = "local_scan" | "metadata_sync" | "remote_popular" | "dlsite_popular";

type DLsitePopularPeriod = "day" | "week" | "month" | "year";

type DLsitePopularRunOptions = {
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagName: string;
};

type RemotePopularRunOptions = {
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  tagName: string;
};

const manuallyRunnableSystemWorkflows: Record<string, SystemRunKind[]> = {
  local_library_scan: ["local_scan"],
  metadata_sync: ["metadata_sync"],
  remote_popular_collection: ["remote_popular"],
  dlsite_popular_collection: ["dlsite_popular"],
};

const sortDefinitionsForSidebar = (definitions: WorkflowDefinition[], systemMode: boolean) => {
  if (!systemMode) {
    return definitions;
  }
  return [...definitions].sort((left, right) => {
    const leftManual = manuallyRunnableSystemWorkflows[left.code]?.length ? 0 : 1;
    const rightManual = manuallyRunnableSystemWorkflows[right.code]?.length ? 0 : 1;
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
  canTagWorks,
  canManageDownloads,
}: {
  surface: Surface;
  canRun: boolean;
  canSyncMetadata: boolean;
  canTagWorks: boolean;
  canManageDownloads: boolean;
}) {
  const toast = useToast();
  const [workflowView, setWorkflowView] = useState<WorkflowView>(() => storedWorkflowView());
  const [activityView, setActivityView] = useState<ActivityView>(() => activityViewFromLocation());
  const [runDetailView, setRunDetailView] = useState<RunDetailView>("overview");
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [nodeTypes, setNodeTypes] = useState<WorkflowNodeType[]>(fallbackNodeTypes);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsPage, setRunsPage] = useState<WorkflowRunsPage>({ runs: [], page: 1, pageSize: 10, total: 0 });
  const [runPage, setRunPage] = useState(1);
  const [runQuery, setRunQuery] = useState("");
  const [selectedDefinitionIds, setSelectedDefinitionIDs] = useState<Record<DefinitionView, number | null>>(() => ({
    definitions: storedPositiveInt(workflowDefinitionStoragePrefix + "definitions"),
    system: storedPositiveInt(workflowDefinitionStoragePrefix + "system"),
  }));
  const [selectedTriggerId, setSelectedTriggerID] = useState<number | null>(() => storedPositiveInt(workflowTriggerStorageKey));
  const [selectedRunId, setSelectedRunID] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<WorkflowRunDetail | null>(null);
  const [selectedRunEvents, setSelectedRunEvents] = useState<WorkflowEvent[]>([]);
  const [selectedRunCandidates, setSelectedRunCandidates] = useState<WorkflowCandidate[]>([]);
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingNodeIndex, setEditingNodeIndex] = useState<number | null>(null);
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);
  const [runningSystemAction, setRunningSystemAction] = useState<SystemRunKind | null>(null);
  const [isWorkflowMetaLoading, setIsWorkflowMetaLoading] = useState(true);
  const [isRunsLoading, setIsRunsLoading] = useState(true);
  const [isRunDetailLoading, setIsRunDetailLoading] = useState(false);

  const refresh = () => {
    setIsWorkflowMetaLoading(true);
    Promise.all([
      api.listWorkflowDefinitions().then(setDefinitions).catch(() => setDefinitions([])),
      api.listWorkflowNodeTypes().then(setNodeTypes).catch(() => setNodeTypes(fallbackNodeTypes)),
      api.listWorkflowTriggers().then(setTriggers).catch(() => setTriggers([])),
    ]).finally(() => setIsWorkflowMetaLoading(false));
  };

  const refreshRuns = (page = runPage, view = activityView, query = runQuery) => {
    setIsRunsLoading(true);
    api
      .listWorkflowRuns(page, runsPage.pageSize, view, query)
      .then((next) => {
        setRunsPage(next);
        setRuns(next.runs);
      })
      .catch(() => {
        setRunsPage({ runs: [], page, pageSize: runsPage.pageSize, total: 0 });
        setRuns([]);
      })
      .finally(() => setIsRunsLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    refreshRuns(runPage, activityView, runQuery);
  }, [activityView, runPage]);

  useEffect(() => {
    if (surface !== "activity") return;
    const syncView = () => {
      const next = activityViewFromLocation();
      setActivityView(next);
      setRunPage(1);
      setSelectedRunID(null);
      setRunDetailView(next === "logs" ? "logs" : next === "review" ? "items" : "overview");
    };
    window.addEventListener("popstate", syncView);
    window.addEventListener("kikoto:navigation", syncView);
    return () => {
      window.removeEventListener("popstate", syncView);
      window.removeEventListener("kikoto:navigation", syncView);
    };
  }, [surface]);

  const definitionView: DefinitionView = workflowView === "system" ? "system" : "definitions";
  const visibleDefinitions = useMemo(() => {
    if (definitionView === "system") {
      return sortDefinitionsForSidebar(definitions.filter((definition) => definition.scope === "system"), true);
    }
    return definitions.filter((definition) => definition.scope === "user" || Boolean(manuallyRunnableSystemWorkflows[definition.code]?.length));
  }, [definitionView, definitions]);
  const scheduledTriggers = triggers.filter((trigger) => trigger.triggerType !== "manual");
  const visibleRuns = runs;
  const selectedDefinitionId = selectedDefinitionIds[definitionView];

  const selectedDefinition = useMemo(() => {
    return visibleDefinitions.find((definition) => definition.id === selectedDefinitionId) ?? visibleDefinitions[0] ?? null;
  }, [selectedDefinitionId, visibleDefinitions]);

  const selectedTrigger = scheduledTriggers.find((trigger) => trigger.id === selectedTriggerId) ?? scheduledTriggers[0] ?? null;
  const scheduledDefinition = definitions.find((definition) => definition.id === selectedTrigger?.workflowDefinitionId) ?? null;
  const selectedRunSummary = visibleRuns.find((run) => run.id === selectedRunId) ?? visibleRuns[0] ?? null;
  const selectedSystemRunKinds = selectedDefinition ? manuallyRunnableSystemWorkflows[selectedDefinition.code] : undefined;
  const definitionEmptyText = "No runnable or custom workflow definitions exist yet.";

  useEffect(() => {
    if (isWorkflowMetaLoading || workflowView === "scheduled") return;
    const nextID = selectedDefinition?.id ?? null;
    if (selectedDefinitionId !== nextID) {
      setSelectedDefinitionIDs((current) => ({ ...current, [definitionView]: nextID }));
    }
    storePositiveInt(workflowDefinitionStoragePrefix + definitionView, nextID);
  }, [definitionView, isWorkflowMetaLoading, selectedDefinition?.id, selectedDefinitionId, workflowView]);

  useEffect(() => {
    if (isWorkflowMetaLoading) return;
    const nextID = selectedTrigger?.id ?? null;
    if (selectedTriggerId !== nextID) {
      setSelectedTriggerID(nextID);
    }
    storePositiveInt(workflowTriggerStorageKey, nextID);
  }, [isWorkflowMetaLoading, selectedTrigger?.id, selectedTriggerId]);

  const selectWorkflowView = (view: WorkflowView) => {
    setWorkflowView(view);
    storeSessionValue(workflowViewStorageKey, view);
  };

  const selectDefinition = (definition: WorkflowDefinition) => {
    const view: DefinitionView = workflowView === "system" ? "system" : "definitions";
    setSelectedDefinitionIDs((current) => ({ ...current, [view]: definition.id }));
    storePositiveInt(workflowDefinitionStoragePrefix + view, definition.id);
  };

  const selectTrigger = (trigger: WorkflowTrigger) => {
    setSelectedTriggerID(trigger.id);
    storePositiveInt(workflowTriggerStorageKey, trigger.id);
  };

  useEffect(() => {
    if (!selectedRunSummary) {
      setSelectedRun(null);
      setSelectedRunEvents([]);
      setSelectedRunCandidates([]);
      setIsRunDetailLoading(false);
      return;
    }
    setSelectedRunID(selectedRunSummary.id);
    setIsRunDetailLoading(true);
    setSelectedRun(null);
    setSelectedRunEvents([]);
    setSelectedRunCandidates([]);
    Promise.all([
      api.getWorkflowRun(selectedRunSummary.id).then(setSelectedRun).catch(() => setSelectedRun(null)),
      api.listWorkflowRunEvents(selectedRunSummary.id).then(setSelectedRunEvents).catch(() => setSelectedRunEvents([])),
      api.listWorkflowRunCandidates(selectedRunSummary.id).then(setSelectedRunCandidates).catch(() => setSelectedRunCandidates([])),
    ]).finally(() => setIsRunDetailLoading(false));
  }, [selectedRunSummary?.id]);

	useEffect(() => {
	  if (!selectedRunSummary || !["queued", "running"].includes(selectedRunSummary.status)) return;
	  const refreshRunningDetail = () => {
		void Promise.all([
		  api.getWorkflowRun(selectedRunSummary.id).then((next) => {
			setSelectedRun(next);
			setRuns((items) => items.map((item) => item.id === next.id ? { ...item, ...next } : item));
		  }),
		  api.listWorkflowRunEvents(selectedRunSummary.id).then(setSelectedRunEvents),
		]).catch(() => undefined);
	  };
	  const timer = window.setInterval(refreshRunningDetail, 1500);
	  return () => window.clearInterval(timer);
	}, [selectedRunSummary?.id, selectedRunSummary?.status]);

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

  const runPopularCollection = async (options: RemotePopularRunOptions) => {
    setRunningSystemAction("remote_popular");
    try {
      const result = await api.runRemotePopularCollection(options);
      toast.success(`Remote popular run #${result.runId} queued with tag ${result.tagName}.`);
      refresh();
      setActivityView("running");
      setRunPage(1);
      refreshRuns(1, "running", runQuery);
    } catch (error) {
      toast.notify(toastFromError(error, "Remote popular collection could not be queued."));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runDLsitePopularCollection = async (options: DLsitePopularRunOptions) => {
    setRunningSystemAction("dlsite_popular");
    try {
      const result = await api.runDLsitePopularCollection(options);
      toast.success(`DLsite popular run #${result.runId} queued with tag ${result.tagName}.`);
      refresh();
      setActivityView("running");
      setRunPage(1);
      refreshRuns(1, "running", runQuery);
    } catch (error) {
      toast.notify(toastFromError(error, "DLsite popular collection could not be queued."));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runSystemAction = async (kind: SystemRunKind) => {
    if (kind === "local_scan") return runLocalScan();
    if (kind === "metadata_sync") return runMetadataSync();
    if (kind === "remote_popular") return;
    if (kind === "dlsite_popular") return;
  };

  const systemActionBusy = (kind: SystemRunKind) => {
    if (kind === "local_scan") return isRunningScan;
    if (kind === "metadata_sync") return isSyncingMetadata;
    return runningSystemAction === kind;
  };

  const systemActionAllowed = (kind: SystemRunKind) => {
    if (kind === "metadata_sync") return canSyncMetadata;
    if (kind === "dlsite_popular") return canRun && canSyncMetadata && canTagWorks;
    if (kind === "remote_popular") return canRun && canTagWorks;
    return canRun;
  };

  const refreshSelectedRunReview = async () => {
    if (!selectedRunSummary) return;
    const [nextRun, nextCandidates, nextEvents] = await Promise.all([
      api.getWorkflowRun(selectedRunSummary.id).catch(() => selectedRun),
      api.listWorkflowRunCandidates(selectedRunSummary.id).catch(() => []),
      api.listWorkflowRunEvents(selectedRunSummary.id).catch(() => []),
    ]);
    setSelectedRun(nextRun);
    setSelectedRunCandidates(nextCandidates);
    setSelectedRunEvents(nextEvents);
    refreshRuns(runPage, activityView, runQuery);
  };

  const reviewSelectedRun = async () => {
    const run = selectedRun ?? selectedRunSummary;
    if (!run) return;
    try {
      const next = await api.reviewWorkflowRun(run.id);
      setSelectedRun((current) => current && current.id === next.id ? { ...current, ...next } : current);
      setRuns((items) => items.map((item) => (item.id === next.id ? { ...item, ...next } : item)));
      toast.success(`Run #${next.id} marked reviewed.`);
      await refreshSelectedRunReview();
    } catch (error) {
      toast.notify(toastFromError(error, "Mark reviewed failed."));
    }
  };

  const recoverStaleRuns = async () => {
    try {
      const result = await api.recoverStaleWorkflowRuns();
      toast.success(`${result.recovered ?? 0} stale runs recovered.`);
      refreshRuns(runPage, activityView, runQuery);
    } catch (error) {
      toast.notify(toastFromError(error, "Recover stale runs failed."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{surface === "activity" ? "Activity" : "Workflows"}</h2>
          <p className="text-sm text-muted-foreground">
            {surface === "activity" ? "Inspect runs by node state and failure point." : "Run built-in operations or manage custom definition drafts."}
          </p>
        </div>
      </div>

      {surface === "workflows" ? (
        <>
          <SegmentedNav>
            <ViewButton active={workflowView === "definitions"} onClick={() => selectWorkflowView("definitions")} icon={<Workflow className="h-4 w-4" />}>
              Definitions
            </ViewButton>
            <ViewButton active={workflowView === "scheduled"} onClick={() => selectWorkflowView("scheduled")} icon={<CalendarClock className="h-4 w-4" />}>
              Scheduled
            </ViewButton>
          </SegmentedNav>

          {workflowView === "scheduled" ? (
            <Workbench
              left={
                <TriggerSidebar
                  triggers={scheduledTriggers}
                  selectedId={selectedTrigger?.id ?? null}
                  loading={isWorkflowMetaLoading}
                  onSelect={selectTrigger}
                  onCreate={() => setModalMode("create-trigger")}
                />
              }
              right={
                <WorkflowDetail
                  definition={scheduledDefinition}
                  trigger={selectedTrigger}
                  nodeTypes={nodeTypes}
                  readonly
                  onEditTrigger={() => setModalMode("edit-trigger")}
                  onEditDefinition={() => undefined}
                  onEditNode={() => undefined}
                  emptyText="No scheduled workflow triggers exist yet."
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
                  loading={isWorkflowMetaLoading}
                  emptyText={definitionEmptyText}
                  onSelect={selectDefinition}
                  onCreate={() => setModalMode("create-workflow")}
                />
              }
              right={
                <WorkflowDetail
                  definition={selectedDefinition}
                  nodeTypes={nodeTypes}
                  readonly={!selectedDefinition?.editable}
                  systemRunKinds={selectedSystemRunKinds}
                  isSystemActionRunning={systemActionBusy}
                  canRunSystemAction={systemActionAllowed}
                  onRunSystemAction={runSystemAction}
                  onRunRemotePopular={runPopularCollection}
                  canFetchRemotePopular={canManageDownloads}
                  onRunDLsitePopular={runDLsitePopularCollection}
                  emptyText={definitionEmptyText}
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
            <ViewButton active={activityView === "running"} onClick={() => switchActivityView("running", surface, setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<Activity className="h-4 w-4" />}>
              Running
            </ViewButton>
            <ViewButton active={activityView === "review"} onClick={() => switchActivityView("review", surface, setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<FileJson className="h-4 w-4" />}>
              Review
            </ViewButton>
            <ViewButton active={activityView === "failed"} onClick={() => switchActivityView("failed", surface, setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<AlertCircle className="h-4 w-4" />}>
              Failed
            </ViewButton>
            <ViewButton active={activityView === "completed"} onClick={() => switchActivityView("completed", surface, setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<ListChecks className="h-4 w-4" />}>
              Completed
            </ViewButton>
            <ViewButton active={activityView === "logs"} onClick={() => switchActivityView("logs", surface, setActivityView, setRunPage, setSelectedRunID, setRunDetailView)} icon={<FileText className="h-4 w-4" />}>
              Logs
            </ViewButton>
          </SegmentedNav>
          <ActivityToolbar
            query={runQuery}
            onQueryChange={setRunQuery}
            onSearch={() => {
              setRunPage(1);
              setSelectedRunID(null);
              refreshRuns(1, activityView, runQuery);
            }}
            onRecoverStale={recoverStaleRuns}
          />
          <Workbench
            left={
              <RunSidebar
                runs={visibleRuns}
                selectedId={selectedRunSummary?.id ?? null}
                page={runsPage.page}
                pageSize={runsPage.pageSize}
                total={runsPage.total}
                loading={isRunsLoading}
                onSelect={(run) => setSelectedRunID(run.id)}
                onPrevious={() => {
                  setSelectedRunID(null);
                  setRunPage(Math.max(1, runPage - 1));
                }}
                onNext={() => {
                  setSelectedRunID(null);
                  setRunPage(runPage + 1);
                }}
              />
            }
            right={<RunDetail run={selectedRun ?? selectedRunSummary} events={selectedRunEvents} candidates={selectedRunCandidates} nodeTypes={nodeTypes} view={runDetailView} loading={isRunDetailLoading && !selectedRun} onViewChange={setRunDetailView} onCandidateUpdate={refreshSelectedRunReview} onRunAction={refreshSelectedRunReview} onReviewRun={reviewSelectedRun} />}
          />
        </>
      )}

      {modalMode === "create-workflow" && (
        <WorkflowModal
          title="New workflow"
          definition={null}
          nodeTypes={nodeTypes}
          onClose={() => setModalMode(null)}
          onSaved={(definition) => {
            selectDefinition(definition);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-workflow" && selectedDefinition && (
        <WorkflowModal
          title="Edit workflow"
          definition={selectedDefinition}
          nodeTypes={nodeTypes}
          onClose={() => setModalMode(null)}
          onSaved={(definition) => {
            selectDefinition(definition);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-node" && selectedDefinition && editingNodeIndex !== null && (
        <NodeModal
          definition={selectedDefinition}
          nodeTypes={nodeTypes}
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
            selectTrigger(trigger);
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
            selectTrigger(trigger);
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

function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function DefinitionSidebar({
  definitions,
  selectedId,
  canCreate,
  loading,
  emptyText,
  onSelect,
  onCreate,
}: {
  definitions: WorkflowDefinition[];
  selectedId: number | null;
  canCreate: boolean;
  loading?: boolean;
  emptyText: string;
  onSelect: (definition: WorkflowDefinition) => void;
  onCreate: () => void;
}) {
  const readyDefinitions = sortDefinitionsForSidebar(
    definitions.filter((definition) => definition.scope === "system" && Boolean(manuallyRunnableSystemWorkflows[definition.code]?.length)),
    true,
  );
  const customDefinitions = definitions
    .filter((definition) => definition.scope === "user")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <div>
            <div className="text-sm font-semibold">Definitions</div>
            <div className="text-xs text-muted-foreground">Runnable presets and custom drafts.</div>
          </div>
          {canCreate && (
            <Button size="sm" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              New
            </Button>
          )}
        </div>
        <div className="space-y-4">
          {loading ? (
            <SidebarSkeletonRows count={6} />
          ) : (
            <>
              {readyDefinitions.length > 0 && (
                <DefinitionGroup label="Ready to run">
                  {readyDefinitions.map((definition) => <DefinitionListItem key={definition.id} definition={definition} selected={selectedId === definition.id} onSelect={onSelect} />)}
                </DefinitionGroup>
              )}
              <DefinitionGroup label="Custom definitions" action={customDefinitions.length === 0 ? "No drafts yet" : undefined}>
                {customDefinitions.map((definition) => <DefinitionListItem key={definition.id} definition={definition} selected={selectedId === definition.id} onSelect={onSelect} />)}
              </DefinitionGroup>
            </>
          )}
          {!loading && definitions.length === 0 && <EmptyPanel text={emptyText} />}
        </div>
      </CardContent>
    </Card>
  );
}

function DefinitionGroup({ label, action, children }: { label: string; action?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        {action && <span className="font-normal">{action}</span>}
      </div>
      {children}
    </div>
  );
}

function DefinitionListItem({ definition, selected, onSelect }: { definition: WorkflowDefinition; selected: boolean; onSelect: (definition: WorkflowDefinition) => void }) {
  const hasManualAction = Boolean(manuallyRunnableSystemWorkflows[definition.code]?.length);
  return (
    <button
      className={`w-full rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-secondary" : "bg-card hover:bg-muted"}`}
      onClick={() => onSelect(definition)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{definition.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">{definition.code}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge variant={definition.scope === "system" ? "outline" : "secondary"}>{definition.scope === "system" ? "Built-in" : "Custom"}</Badge>
          {hasManualAction && <Badge>Manual</Badge>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span>{parseNodes(definition.definitionJson).length} nodes</span>
        <span>{definition.triggerCount} triggers</span>
      </div>
    </button>
  );
}

function TriggerSidebar({
  triggers,
  selectedId,
  loading,
  onSelect,
  onCreate,
}: {
  triggers: WorkflowTrigger[];
  selectedId: number | null;
  loading?: boolean;
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
          {loading ? (
            <SidebarSkeletonRows count={5} />
          ) : triggers.map((trigger) => (
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
          {!loading && triggers.length === 0 && <EmptyPanel text="No scheduled triggers yet." />}
        </div>
      </CardContent>
    </Card>
  );
}

function ActivityToolbar({
  query,
  onQueryChange,
  onSearch,
  onRecoverStale,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRecoverStale: () => Promise<void>;
}) {
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
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground md:justify-end">
        <Button size="sm" variant="outline" onClick={() => void onRecoverStale()}>
          Recover stale
        </Button>
      </div>
    </div>
  );
}

function RunSidebar({
  runs,
  selectedId,
  page,
  pageSize,
  total,
  loading,
  onSelect,
  onPrevious,
  onNext,
}: {
  runs: WorkflowRun[];
  selectedId: number | null;
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onSelect: (run: WorkflowRun) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, (page - 1) * pageSize + runs.length);
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center justify-between px-1 text-sm">
          <div>
            <div className="font-semibold">Runs</div>
            <div className="text-xs text-muted-foreground">
              {start}-{end} of {total}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button size="icon" variant="outline" className="h-8 w-8" disabled={page <= 1} onClick={onPrevious} aria-label="Previous runs page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" disabled={page >= totalPages} onClick={onNext} aria-label="Next runs page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="divide-y rounded-md border">
          {loading ? (
            <RunSidebarSkeletonRows />
          ) : runs.map((run) => (
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
        {!loading && runs.length === 0 && <EmptyPanel text="No runs in this view." />}
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
          <span>Page {page} / {totalPages}</span>
          <span>{pageSize} per page</span>
        </div>
      </CardContent>
    </Card>
  );
}

function SidebarSkeletonRows({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-md border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonLine className="h-4 w-3/4" />
              <SkeletonLine className="h-3 w-1/2" />
            </div>
            <SkeletonLine className="h-5 w-16" />
          </div>
          <div className="mt-3 flex gap-2">
            <SkeletonLine className="h-3 w-14" />
            <SkeletonLine className="h-3 w-16" />
          </div>
        </div>
      ))}
    </>
  );
}

function RunSidebarSkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <SkeletonLine className="h-4 w-4/5" />
              <SkeletonLine className="h-3 w-2/5" />
            </div>
            <SkeletonLine className="h-5 w-16" />
          </div>
          <div className="mt-3 flex gap-3">
            <SkeletonLine className="h-3 w-16" />
            <SkeletonLine className="h-3 w-20" />
            <SkeletonLine className="h-3 w-12" />
          </div>
        </div>
      ))}
    </>
  );
}

function WorkflowDetail({
  definition,
  trigger,
  nodeTypes,
  readonly,
  systemRunKinds,
  isSystemActionRunning,
  canRunSystemAction,
  onRunSystemAction,
  onRunRemotePopular,
  canFetchRemotePopular = false,
  onRunDLsitePopular,
  emptyText = "Select a workflow to inspect its node pipeline.",
  onEditDefinition,
  onEditTrigger,
  onEditNode,
}: {
  definition: WorkflowDefinition | null;
  trigger?: WorkflowTrigger | null;
  nodeTypes: WorkflowNodeType[];
  readonly: boolean;
  systemRunKinds?: SystemRunKind[];
  isSystemActionRunning?: (kind: SystemRunKind) => boolean;
  canRunSystemAction?: (kind: SystemRunKind) => boolean;
  onRunSystemAction?: (kind: SystemRunKind) => Promise<void>;
  onRunRemotePopular?: (options: RemotePopularRunOptions) => Promise<void>;
  canFetchRemotePopular?: boolean;
  onRunDLsitePopular?: (options: DLsitePopularRunOptions) => Promise<void>;
  emptyText?: string;
  onEditDefinition: () => void;
  onEditTrigger?: () => void;
  onEditNode: (index: number) => void;
}) {
  if (!definition) {
    return <EmptyPanel text={emptyText} />;
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
            {definition.scope === "system" && systemRunKinds && onRunSystemAction && systemRunKinds.filter((kind) => kind !== "dlsite_popular" && kind !== "remote_popular").map((kind) => {
              const running = isSystemActionRunning?.(kind) ?? false;
              const allowed = canRunSystemAction?.(kind) ?? false;
              return (
                <Button key={kind} size="sm" onClick={() => void onRunSystemAction(kind)} disabled={running || !allowed}>
                  <Play className="h-4 w-4" />
                  {running ? "Running" : systemRunKindLabel(kind)}
                </Button>
              );
            })}
          </div>
        </div>

        {systemRunKinds?.includes("dlsite_popular") && onRunDLsitePopular && (
          <DLsitePopularRunPanel
            running={isSystemActionRunning?.("dlsite_popular") ?? false}
            allowed={canRunSystemAction?.("dlsite_popular") ?? false}
            onRun={onRunDLsitePopular}
          />
        )}

        {systemRunKinds?.includes("remote_popular") && onRunRemotePopular && (
          <RemotePopularRunPanel
            running={isSystemActionRunning?.("remote_popular") ?? false}
            allowed={canRunSystemAction?.("remote_popular") ?? false}
            canFetch={canFetchRemotePopular}
            onRun={onRunRemotePopular}
          />
        )}

        {definition.scope === "system" && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {systemRunKinds?.length
              ? "This system workflow is read-only, but it exposes a manual action."
              : "This system workflow is read-only and is triggered by application actions."}
          </div>
        )}
        {trigger && <TriggerSummary trigger={trigger} />}
        <NodePipeline nodes={nodes} nodeTypes={nodeTypes} readonly={readonly} onEditNode={onEditNode} />
      </CardContent>
    </Card>
  );
}

function systemRunKindLabel(kind: SystemRunKind) {
  switch (kind) {
    case "local_scan":
      return "Run local scan";
    case "metadata_sync":
      return "Sync metadata";
    case "remote_popular":
      return "Collect remote popular";
    case "dlsite_popular":
      return "Collect DLsite popular";
  }
}

function RemotePopularRunPanel({
  running,
  allowed,
  canFetch,
  onRun,
}: {
  running: boolean;
  allowed: boolean;
  canFetch: boolean;
  onRun: (options: RemotePopularRunOptions) => Promise<void>;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceId, setSourceId] = useState(0);
  const [action, setAction] = useState<"track" | "fetch">("track");
  const [limit, setLimit] = useState(25);
  const [tagName, setTagName] = useState("");
  const [tagCustomized, setTagCustomized] = useState(false);
  const [loadingSources, setLoadingSources] = useState(true);
  const compatibleSources = useMemo(
    () => sources.filter((source) => source.enabled && ["kikoeru_compatible", "kikoeru_compilable_number178"].includes(source.sourceType)),
    [sources],
  );
  const selectedSource = compatibleSources.find((source) => source.id === sourceId) ?? null;
  const generatedTag = remotePopularTagName(selectedSource?.code ?? "remote", action, new Date());

  useEffect(() => {
    let active = true;
    api.listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const first = items.find((source) => source.enabled && ["kikoeru_compatible", "kikoeru_compilable_number178"].includes(source.sourceType));
        setSourceId((current) => current || first?.id || 0);
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!tagCustomized) setTagName(generatedTag);
  }, [generatedTag, tagCustomized]);

  const canSubmit = allowed && sourceId > 0 && tagName.trim().length > 0 && (action !== "fetch" || canFetch);
  return (
    <div className="rounded-md border bg-background p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(240px,0.7fr)]">
        <div className="space-y-4">
          <label className="grid gap-2 text-sm font-medium">
            Remote source
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={sourceId}
              disabled={loadingSources || compatibleSources.length === 0}
              onChange={(event) => setSourceId(Number(event.target.value))}
            >
              {compatibleSources.length === 0 && <option value={0}>{loadingSources ? "Loading sources" : "No compatible source"}</option>}
              {compatibleSources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-sm font-medium">Action</div>
              <div className="mt-2 inline-flex rounded-md border bg-muted/40 p-1" aria-label="Remote popular action">
                {(["track", "fetch"] as const).map((item) => (
                  <button
                    key={item}
                    className={`h-8 rounded px-3 text-sm font-medium capitalize transition-colors ${action === item ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    aria-pressed={action === item}
                    onClick={() => setAction(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
              {action === "fetch" && !canFetch && <div className="mt-1 text-xs text-destructive">Fetch requires download management permission.</div>}
            </div>
            <label className="grid content-start gap-2 text-sm font-medium">
              Work limit
              <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
                {[10, 25, 50, 100].map((item) => <option key={item} value={item}>{item} works</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="flex min-w-0 flex-col justify-between gap-4 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <label className="grid gap-2 text-sm font-medium">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Tag className="h-3.5 w-3.5" />
              User tag
            </span>
            <input
              className="h-9 min-w-0 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={tagName}
              maxLength={40}
              onChange={(event) => {
                setTagCustomized(true);
                setTagName(event.target.value);
              }}
            />
          </label>
          <Button disabled={running || !canSubmit} onClick={() => void onRun({ sourceId, action, limit, tagName: tagName.trim() })}>
            <Play className="h-4 w-4" />
            {running ? "Queueing" : "Run collection"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function remotePopularTagName(sourceCode: string, action: "track" | "fetch", now: Date) {
  const date = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const source = sourceCode.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 12) || "remote";
  return `${date}-${source}-${action}-popular`.slice(0, 40);
}

function DLsitePopularRunPanel({ running, allowed, onRun }: { running: boolean; allowed: boolean; onRun: (options: DLsitePopularRunOptions) => Promise<void> }) {
  const [period, setPeriod] = useState<DLsitePopularPeriod>("day");
  const [recentOnly, setRecentOnly] = useState(true);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const releaseWindow: "30d" | "" = period === "year" ? "" : recentOnly ? "30d" : "";
  const tagName = dlsitePopularTagName(period, releaseWindow, year, new Date());
  const years = Array.from({ length: currentYear - 1999 }, (_, index) => currentYear - index);
  const periodOptions: { value: DLsitePopularPeriod; label: string }[] = [
    { value: "day", label: "24h" },
    { value: "week", label: "7d" },
    { value: "month", label: "30d" },
    { value: "year", label: "Year" },
  ];

  return (
    <div className="rounded-md border bg-background p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(240px,0.7fr)]">
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium">Ranking period</div>
            <div className="mt-2 inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1" aria-label="DLsite ranking period">
              {periodOptions.map((option) => (
                <button
                  key={option.value}
                  className={`h-8 shrink-0 rounded px-3 text-sm font-medium transition-colors ${period === option.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  aria-pressed={period === option.value}
                  onClick={() => setPeriod(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {period === "year" ? (
            <label className="grid max-w-56 gap-2 text-sm font-medium">
              Ranking year
              <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={year} onChange={(event) => setYear(Number(event.target.value))}>
                {years.map((item) => <option key={item} value={item}>{item}{item === currentYear ? " (current)" : ""}</option>)}
              </select>
            </label>
          ) : (
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">Recent releases only</div>
                <div className="text-xs text-muted-foreground">Limit the ranking to works released within 30 days.</div>
              </div>
              <Switch checked={recentOnly} onCheckedChange={setRecentOnly} aria-label="Only works released within 30 days" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col justify-between gap-4 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Tag className="h-3.5 w-3.5" />
              Tag preview
            </div>
            <code className="mt-2 block break-all rounded-md bg-muted px-3 py-2 text-xs">{tagName}</code>
          </div>
          <Button disabled={running || !allowed} onClick={() => void onRun({ period, releaseWindow, year: period === "year" ? year : 0, tagName })}>
            <Play className="h-4 w-4" />
            {running ? "Queueing" : "Run collection"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function dlsitePopularTagName(period: DLsitePopularPeriod, releaseWindow: "30d" | "", year: number, now: Date) {
  const date = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  if (period === "year") return `${date}-DL-year-${year}-popular`;
  const periodLabel = period === "day" ? "24h" : period === "week" ? "7d" : "30d";
  return `${date}-DL-${periodLabel}-${releaseWindow === "30d" ? "r30d" : "all"}-popular`;
}

function RunDetail({
  run,
  events,
  candidates,
  nodeTypes,
  view,
  loading = false,
  onViewChange,
  onCandidateUpdate,
  onRunAction,
  onReviewRun,
}: {
  run: WorkflowRunDetail | WorkflowRun | null;
  events: WorkflowEvent[];
  candidates: WorkflowCandidate[];
  nodeTypes: WorkflowNodeType[];
  view: RunDetailView;
  loading?: boolean;
  onViewChange: (view: RunDetailView) => void;
  onCandidateUpdate: () => Promise<void>;
  onRunAction: () => Promise<void>;
  onReviewRun: () => Promise<void>;
}) {
  if (!run) {
    return loading ? <RunDetailSkeleton view={view} /> : <EmptyPanel text="Select a run to inspect execution by node." />;
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
          <div className="space-y-2">
            <RunMetrics run={run} />
            <RunReviewAction run={run} onReviewRun={onReviewRun} />
            <RunActions run={run} onRunAction={onRunAction} />
          </div>
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
          loading ? <RunOverviewSkeleton /> : <RunOverview run={run} nodeRuns={nodeRuns} />
        ) : view === "steps" ? (
          loading ? <RunNodePipelineSkeleton /> : nodeRuns.length > 0 ? <RunNodePipeline nodes={nodeRuns} nodeTypes={nodeTypes} /> : <EmptyPanel text="This run has no node detail yet." />
        ) : view === "items" ? (
          loading ? <RunItemsSkeleton /> : <RunItems run={run} nodeRuns={nodeRuns} candidates={candidates} onCandidateUpdate={onCandidateUpdate} />
        ) : (
          loading ? <RunLogsSkeleton /> : <RunLogs run={run} nodeRuns={nodeRuns} events={events} />
        )}
      </CardContent>
    </Card>
  );
}

function RunDetailSkeleton({ view }: { view: RunDetailView }) {
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <SkeletonLine className="h-6 w-56" />
              <SkeletonLine className="h-5 w-20" />
            </div>
            <SkeletonLine className="h-4 w-80 max-w-full" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <SkeletonLine className="h-8 w-28" />
            <SkeletonLine className="h-8 w-28" />
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
          {Array.from({ length: 4 }, (_, index) => <SkeletonLine key={index} className="h-9 w-24 shrink-0" />)}
        </div>
        {view === "overview" ? <RunOverviewSkeleton /> : view === "steps" ? <RunNodePipelineSkeleton /> : view === "items" ? <RunItemsSkeleton /> : <RunLogsSkeleton />}
      </CardContent>
    </Card>
  );
}

function RunOverviewSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-md border p-3">
        <SkeletonLine className="h-4 w-28" />
        <div className="mt-3 space-y-2">
          <SkeletonLine className="h-3 w-full" />
          <SkeletonLine className="h-3 w-5/6" />
          <SkeletonLine className="h-3 w-2/3" />
        </div>
      </div>
      <div className="rounded-md border p-3">
        <SkeletonLine className="h-4 w-32" />
        <div className="mt-3 grid gap-2">
          {Array.from({ length: 4 }, (_, index) => <SkeletonLine key={index} className="h-3 w-full" />)}
        </div>
      </div>
    </div>
  );
}

function RunNodePipelineSkeleton() {
  return (
    <div className="divide-y rounded-md border">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="grid gap-2 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <SkeletonLine className="h-4 w-44" />
              <SkeletonLine className="h-3 w-28" />
            </div>
            <SkeletonLine className="h-5 w-20" />
          </div>
          <SkeletonLine className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

function RunItemsSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="rounded-md border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <SkeletonLine className="h-4 w-48" />
              <SkeletonLine className="h-3 w-32" />
            </div>
            <SkeletonLine className="h-5 w-16" />
          </div>
          <div className="mt-3 space-y-2">
            <SkeletonLine className="h-3 w-full" />
            <SkeletonLine className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RunLogsSkeleton() {
  return (
    <div className="divide-y rounded-md border">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="grid gap-2 p-3">
          <div className="flex gap-2">
            <SkeletonLine className="h-4 w-16" />
            <SkeletonLine className="h-4 w-24" />
          </div>
          <SkeletonLine className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

function RunReviewAction({ run, onReviewRun }: { run: WorkflowRunDetail | WorkflowRun; onReviewRun: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const hasReviewSignal = reviewCount(run) > 0 || Boolean(run.reviewedAt);
  if (!hasReviewSignal) return null;
  const hasPendingCandidates = run.pendingCandidates > 0;
  const reviewed = Boolean(run.reviewedAt);
  return (
    <div className="flex justify-end">
      <Button
        size="sm"
        variant={reviewed ? "secondary" : "outline"}
        disabled={busy || hasPendingCandidates || reviewed}
        title={hasPendingCandidates ? "Resolve pending candidates before marking this run reviewed." : reviewed ? `Reviewed ${run.reviewedAt}` : "Mark this run reviewed"}
        onClick={async () => {
          setBusy(true);
          try {
            await onReviewRun();
          } finally {
            setBusy(false);
          }
        }}
      >
        <CheckCircle2 className="h-4 w-4" />
        {reviewed ? "Reviewed" : "Mark reviewed"}
      </Button>
    </div>
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
              <CandidateReviewCard key={candidate.id} candidate={candidate} onCandidateUpdate={onCandidateUpdate} />
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

function CandidateReviewCard({ candidate, onCandidateUpdate }: { candidate: WorkflowCandidate; onCandidateUpdate: () => Promise<void> }) {
  const [confirmDeleteOldFiles, setConfirmDeleteOldFiles] = useState(false);
  const [archiveDeleteStep, setArchiveDeleteStep] = useState<0 | 1 | 2>(0);
  const payload = parseJSONRecord(candidate.payloadJson);
  const cleanupLocations = candidate.type === "local_fetch_merge_cleanup" ? localCleanupLocations(payload) : [];
  const archivedRoots = candidate.type === "local_fetch_merge_cleanup" ? localArchivedRoots(payload) : [];
  const duplicateFolders = candidate.type === "local_duplicate_work_folder" ? localDuplicateFolders(payload) : [];
  const needsReview = candidateNeedsReview(candidate);
  const cleanup = async (action: "mark_unavailable" | "delete_files") => {
    if (cleanupLocations.length === 0) return;
    await api.cleanupLocalWorkflowCandidate(candidate.id, {
      action,
      locationIds: cleanupLocations.map((location) => location.locationId),
    });
    setConfirmDeleteOldFiles(false);
    await onCandidateUpdate();
  };
  const reviewArchive = async (action: "keep_archived" | "delete_archived") => {
    await api.reviewArchivedFetchRoots(candidate.id, action, action === "delete_archived" ? "DELETE" : "");
    setArchiveDeleteStep(0);
    await onCandidateUpdate();
  };
  return (
    <div className="grid gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{candidate.externalKey || candidate.type}</div>
          <div className="text-xs text-muted-foreground">{candidate.type} · updated {candidate.updatedAt}</div>
        </div>
        <StatusBadge status={candidate.status} />
      </div>

      {candidate.type === "local_fetch_merge_cleanup" && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">{archivedRoots.length > 0 ? "Archived local roots" : "Old local locations"}</div>
          {archivedRoots.map((root) => (
            <div key={root.folderId} className="space-y-1 border-b py-2 last:border-b-0">
              <div className="font-medium">{root.originalPath}</div>
              <div className="truncate text-muted-foreground" title={root.archivePath}>{root.archivePath}</div>
              <div className="text-muted-foreground">{root.fileCount} files · {formatBytes(root.sizeBytes)}</div>
              {root.files.slice(0, 12).map((file) => <div key={file.path} className="flex gap-2 pl-2"><span className="min-w-0 flex-1 truncate">{file.path}</span><span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span></div>)}
              {root.files.length > 12 && <div className="pl-2 text-muted-foreground">+{root.files.length - 12} more</div>}
            </div>
          ))}
          {archivedRoots.length === 0 && cleanupLocations.length > 0 ? cleanupLocations.slice(0, 8).map((location) => (
            <div key={location.locationId} className="flex gap-2 py-0.5">
              <span className="w-12 shrink-0 text-muted-foreground">#{location.locationId}</span>
              <span className="min-w-0 flex-1 truncate">{location.path}</span>
              {location.sizeBytes !== null && <span className="shrink-0 text-muted-foreground">{formatBytes(location.sizeBytes)}</span>}
            </div>
          )) : archivedRoots.length === 0 && <div className="text-muted-foreground">No selectable local locations in this candidate.</div>}
          {archivedRoots.length === 0 && cleanupLocations.length > 8 && <div className="pt-1 text-muted-foreground">+{cleanupLocations.length - 8} more</div>}
        </div>
      )}

      {candidate.type === "local_duplicate_work_folder" && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">Duplicate local folders</div>
          {duplicateFolders.map((folder) => (
            <div key={folder.relPath} className="grid gap-0.5 py-1">
              <div className="truncate">{folder.relPath}</div>
              <div className="text-muted-foreground">{folder.files} files · {folder.audioFiles} audio · {formatBytes(folder.sizeBytes)}</div>
            </div>
          ))}
        </div>
      )}

      {candidate.type !== "local_fetch_merge_cleanup" && candidate.type !== "local_duplicate_work_folder" && (
        <JsonPreview value={candidate.payloadJson} empty="No candidate payload." compact />
      )}
      {hasNonEmptyJSON(candidate.decisionJson) && <JsonPreview value={candidate.decisionJson} empty="No decision payload." compact />}
      {needsReview && (
        <div className="flex flex-wrap gap-2">
          {candidate.type === "local_fetch_merge_cleanup" && cleanupLocations.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void cleanup("mark_unavailable")}>
                Hide old locations
              </Button>
              <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:text-destructive" onClick={() => setConfirmDeleteOldFiles(true)}>
                Delete old files
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && archivedRoots.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void reviewArchive("keep_archived")}>Keep archived</Button>
              <Button size="sm" variant="outline" className="border-destructive/40 text-destructive hover:text-destructive" onClick={() => setArchiveDeleteStep(1)}>Delete archive</Button>
            </>
          )}
          {archivedRoots.length === 0 && (
            <>
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
            </>
          )}
        </div>
      )}
      {confirmDeleteOldFiles && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <div className="text-sm font-semibold text-destructive">Delete old local files?</div>
          <div className="mt-1 text-sm text-muted-foreground">This deletes the selected old files from disk and marks their locations unavailable. Work metadata is kept.</div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmDeleteOldFiles(false)}>
              Cancel
            </Button>
            <Button size="sm" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void cleanup("delete_files")}>
              Delete files
            </Button>
          </div>
        </div>
      )}
      {archiveDeleteStep > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <div className="text-sm font-semibold text-destructive">{archiveDeleteStep === 1 ? "Review archived directories" : "Final confirmation"}</div>
          <div className="mt-1 text-sm text-muted-foreground">{archiveDeleteStep === 1 ? "These archived roots will be permanently removed from disk." : "This cannot be undone. Work metadata and the published Fetch result will be kept."}</div>
          <div className="mt-2 space-y-1 text-xs">{archivedRoots.map((root) => <div key={root.folderId} className="truncate" title={root.archivePath}>{root.archivePath}</div>)}</div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setArchiveDeleteStep(0)}>Cancel</Button>
            {archiveDeleteStep === 1 ? (
              <Button size="sm" variant="outline" onClick={() => setArchiveDeleteStep(2)}>Continue</Button>
            ) : (
              <Button size="sm" className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void reviewArchive("delete_archived")}>Permanently delete</Button>
            )}
          </div>
        </div>
      )}
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

function NodePipeline({ nodes, nodeTypes, readonly, onEditNode }: { nodes: WorkflowNode[]; nodeTypes: WorkflowNodeType[]; readonly: boolean; onEditNode: (index: number) => void }) {
  return (
    <div className="grid gap-3">
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-stretch gap-3">
          {nodes.map((node, index) => (
            <div key={`${node.id}-${index}`} className="flex items-center gap-3">
              <NodeCard
                title={node.displayName || node.id}
                subtitle={nodeSubtitle(node.type, nodeTypes)}
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
      <WorkflowHints nodes={nodes} nodeTypes={nodeTypes} compact />
    </div>
  );
}

function RunNodePipeline({ nodes, nodeTypes }: { nodes: WorkflowNodeRun[]; nodeTypes: WorkflowNodeType[] }) {
  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex min-w-max items-stretch gap-3">
        {nodes.map((node, index) => (
          <div key={node.id} className="flex items-center gap-3">
            <NodeCard title={node.displayName || node.nodeId} subtitle={nodeSubtitle(node.nodeType, nodeTypes)} status={node.status} error={node.errorMessage} readonly />
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
  nodeTypes,
  onClose,
  onSaved,
}: {
  title: string;
  definition: WorkflowDefinition | null;
  nodeTypes: WorkflowNodeType[];
  onClose: () => void;
  onSaved: (definition: WorkflowDefinition) => void;
}) {
  const [code, setCode] = useState(definition?.code ?? `custom_workflow_${Date.now().toString().slice(-5)}`);
  const [displayName, setDisplayName] = useState(definition?.displayName ?? "New workflow");
  const [description, setDescription] = useState(definition?.description ?? "");
  const [templateId, setTemplateID] = useState(workflowTemplates[1].id);
  const [nodes, setNodes] = useState<WorkflowNode[]>(definition ? parseNodes(definition.definitionJson) : workflowTemplates[1].nodes);
  const recommendedPhase = recommendedNextPhase(nodes, nodeTypes);
  const [insertPhase, setInsertPhase] = useState(recommendedPhase);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setInsertPhase(recommendedNextPhase(nodes, nodeTypes));
  }, [nodes, nodeTypes]);

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
            <div className="flex items-center gap-2">
              <select
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={insertPhase}
                onChange={(event) => setInsertPhase(event.target.value)}
                aria-label="Node phase to add"
              >
                {availableInsertPhases(nodeTypes).map((phase) => (
                  <option key={phase} value={phase}>{phase}</option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={() => setNodes((current) => [...current, createSuggestedNode(current, nodeTypes, insertPhase)])}>
                <Plus className="h-4 w-4" />
                Add node
              </Button>
            </div>
          </div>
          <WorkflowHints nodes={nodes} nodeTypes={nodeTypes} />
          <div className="grid gap-2">
            {nodes.map((node, index) => (
              <NodeInlineEditor key={`${node.id}-${index}`} node={node} nodeTypes={nodeTypes} onChange={(patch) => setNodes(updateNodes(nodes, index, patch))} onRemove={() => setNodes(nodes.filter((_, nodeIndex) => nodeIndex !== index))} />
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
  nodeTypes,
  nodeIndex,
  onClose,
  onSaved,
}: {
  definition: WorkflowDefinition;
  nodeTypes: WorkflowNodeType[];
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
        <NodeInlineEditor node={node} nodeTypes={nodeTypes} onChange={(patch) => setNode({ ...node, ...patch })} />
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
          <div className="flex items-center gap-2 self-end pb-1 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable trigger" />
            <span>Enabled</span>
          </div>
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

function NodeInlineEditor({
  node,
  nodeTypes,
  onChange,
  onRemove,
}: {
  node: WorkflowNode;
  nodeTypes: WorkflowNodeType[];
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRemove?: () => void;
}) {
  const visibleTypes = nodeTypes.filter((type) => type.userVisible || type.type === node.type);
  const metadata = nodeTypes.find((type) => type.type === node.type);
  const configFields = metadata ? schemaFieldNames(metadata.configSchema) : [];
  const configKey = JSON.stringify(node.config ?? {});
  const [configDraft, setConfigDraft] = useState(JSON.stringify(node.config ?? {}, null, 2));
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    setConfigDraft(JSON.stringify(node.config ?? {}, null, 2));
    setConfigError("");
  }, [node.id, node.type, configKey]);

  const commitConfigDraft = () => {
    try {
      const parsed = JSON.parse(configDraft);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setConfigError("Config must be a JSON object.");
        return;
      }
      setConfigError("");
      onChange({ config: parsed as Record<string, unknown> });
    } catch {
      setConfigError("Config JSON is invalid.");
    }
  };

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="grid gap-2 md:grid-cols-[1fr_1.3fr_1fr_auto]">
        <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={node.id} onChange={(event) => onChange({ id: event.target.value })} />
        <select className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" value={node.type} onChange={(event) => onChange({ type: event.target.value, config: {} })}>
          {phaseOrder.map((phase) => {
            const options = visibleTypes.filter((type) => type.phase === phase);
            if (options.length === 0) return null;
            return (
              <optgroup key={phase} label={phase}>
                {options.map((option) => (
                  <option key={option.type} value={option.type}>{option.displayName}</option>
                ))}
              </optgroup>
            );
          })}
          {visibleTypes.some((type) => !phaseOrder.includes(type.phase as (typeof phaseOrder)[number])) && (
            <optgroup label="other">
              {visibleTypes.filter((type) => !phaseOrder.includes(type.phase as (typeof phaseOrder)[number])).map((option) => (
                <option key={option.type} value={option.type}>{option.displayName}</option>
              ))}
            </optgroup>
          )}
        </select>
        <input className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" placeholder="Display name" value={node.displayName ?? ""} onChange={(event) => onChange({ displayName: event.target.value })} />
        {onRemove && (
          <Button size="icon" variant="outline" aria-label="Remove node" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {metadata && (
        <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{metadata.phase} · {metadata.type}</div>
            <div className="mt-1">{metadata.description}</div>
            <div className="mt-2 grid gap-1">
              <span>Config: {schemaFields(metadata.configSchema)}</span>
              <span>Input: {schemaFields(metadata.inputSchema)}</span>
              <span>Output: {schemaFields(metadata.outputSchema)}</span>
            </div>
          </div>
          <div className="grid gap-3">
            <ConfigFields
              fields={configFields}
              config={node.config ?? {}}
              onChange={(config) => onChange({ config })}
            />
            <Field label="Config JSON">
              <textarea
                className="min-h-24 rounded-md border bg-card px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                value={configDraft}
                onBlur={commitConfigDraft}
                onChange={(event) => setConfigDraft(event.target.value)}
              />
              {configError && <span className="text-xs text-destructive">{configError}</span>}
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigFields({
  fields,
  config,
  onChange,
}: {
  fields: string[];
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  if (fields.length === 0) {
    return <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">No structured config fields.</div>;
  }

  const updateField = (field: string, value: unknown) => {
    const next = { ...config };
    if (value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[field];
    } else {
      next[field] = value;
    }
    onChange(next);
  };

  return (
    <div className="grid gap-2 rounded-md border bg-background p-3">
      <div className="text-xs font-medium text-muted-foreground">Config fields</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((field) => {
          const kind = configFieldKind(field);
          const value = config[field];
          if (kind === "boolean") {
            return (
              <div key={field} className="flex h-9 items-center justify-between gap-2 rounded-md border bg-card px-3 text-sm">
                <span>{field}</span>
                <Switch
                  checked={Boolean(value)}
                  onCheckedChange={(checked) => updateField(field, checked)}
                  aria-label={`Toggle ${field}`}
                />
              </div>
            );
          }
          return (
            <Field key={field} label={field}>
              <input
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                type={kind === "number" ? "number" : "text"}
                value={formatConfigInputValue(value)}
                onChange={(event) => updateField(field, parseConfigInputValue(event.target.value, kind, field))}
              />
            </Field>
          );
        })}
      </div>
    </div>
  );
}

function WorkflowHints({ nodes, nodeTypes, compact = false }: { nodes: WorkflowNode[]; nodeTypes: WorkflowNodeType[]; compact?: boolean }) {
  const hints = workflowHints(nodes, nodeTypes);
  if (hints.length === 0) {
    return compact ? null : (
      <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        Workflow shape looks consistent.
      </div>
    );
  }

  return (
    <div className="grid gap-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
      {hints.map((hint) => (
        <div key={hint} className="flex gap-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>{hint}</span>
        </div>
      ))}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4 backdrop-blur-sm">
      <div className="app-scroll max-h-[86vh] w-full max-w-3xl overflow-auto rounded-lg border bg-card shadow-xl">
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

function RunActions({ run, onRunAction }: { run: WorkflowRun; onRunAction: () => Promise<void> }) {
  const cancellable = ["queued", "running"].includes(run.status);
  const retryable = run.status === "failed" && [
    "local_library_scan", "metadata_sync", "remote_work_fetch", "media_cache",
    "media_cache_cleanup", "media_location_cleanup", "local_media_delete", "local_location_cleanup", "remote_popular_collection",
  ].includes(run.workflowCode);
  if (!cancellable && !retryable) {
    return null;
  }
  return (
    <div className="flex justify-end gap-2">
      {cancellable && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await api.cancelWorkflowRun(run.id);
            await onRunAction();
          }}
        >
          Cancel
        </Button>
      )}
      {retryable && (
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await api.retryWorkflowRun(run.id);
            await onRunAction();
          }}
        >
          Retry
        </Button>
      )}
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
    <pre className={`app-scroll mt-2 overflow-auto rounded-md border bg-background p-3 text-xs text-muted-foreground ${compact ? "max-h-32" : "max-h-56"}`}>
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

function availableInsertPhases(nodeTypes: WorkflowNodeType[]) {
  const phases = phaseOrder.filter((phase) => nodeTypes.some((nodeType) => nodeType.userVisible && nodeType.phase === phase));
  return phases.length > 0 ? phases : ["filter"];
}

function recommendedNextPhase(nodes: WorkflowNode[], nodeTypes: WorkflowNodeType[]) {
  const phases = availableInsertPhases(nodeTypes);
  if (nodes.length === 0) {
    return phases.includes("target") ? "target" : phases[0];
  }
  const lastKnownNode = [...nodes].reverse().map((node) => nodeTypes.find((nodeType) => nodeType.type === node.type)).find(Boolean);
  if (!lastKnownNode) {
    return phases[0];
  }
  const lastIndex = phaseOrder.indexOf(lastKnownNode.phase as (typeof phaseOrder)[number]);
  const nextPhase = phaseOrder.slice(Math.max(0, lastIndex + 1)).find((phase) => phases.includes(phase));
  return nextPhase ?? lastKnownNode.phase;
}

function createSuggestedNode(nodes: WorkflowNode[], nodeTypes: WorkflowNodeType[], phase: string): WorkflowNode {
  const visibleTypes = nodeTypes.filter((nodeType) => nodeType.userVisible);
  const selectedType = visibleTypes.find((nodeType) => nodeType.phase === phase) ?? visibleTypes[0] ?? nodeTypes[0];
  const type = selectedType?.type ?? "filter_candidates";
  const baseID = nodeIDBase(type);
  const used = new Set(nodes.map((node) => node.id));
  let id = baseID;
  let suffix = 2;
  while (used.has(id)) {
    id = `${baseID}_${suffix}`;
    suffix += 1;
  }
  return { id, type, displayName: selectedType?.displayName ?? type };
}

function nodeIDBase(type: string) {
  return type
    .replace(/^(select|discover|filter|match|plan|materialize|verify|sync|cleanup|dispatch)_/, "")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "") || "node";
}

function workflowHints(nodes: WorkflowNode[], nodeTypes: WorkflowNodeType[]) {
  const hints: string[] = [];
  const typeMap = new Map(nodeTypes.map((nodeType) => [nodeType.type, nodeType]));
  const seen = new Set<string>();
  let hasTarget = false;
  let hasCommit = false;
  let lastPhaseIndex = -1;

  nodes.forEach((node, index) => {
    const nodeID = node.id.trim();
    const metadata = typeMap.get(node.type);
    if (!nodeID) {
      hints.push(`Node ${index + 1} needs an id.`);
    } else if (seen.has(nodeID)) {
      hints.push(`Node id "${nodeID}" is duplicated.`);
    }
    seen.add(nodeID);

    if (!metadata) {
      hints.push(`${nodeID || `Node ${index + 1}`} uses an unknown type: ${node.type}.`);
      return;
    }

    if (metadata.phase === "target") {
      hasTarget = true;
    }
    if (metadata.phase === "commit") {
      hasCommit = true;
    }
    const phaseIndex = phaseOrder.indexOf(metadata.phase as (typeof phaseOrder)[number]);
    if (phaseIndex >= 0 && lastPhaseIndex > phaseIndex) {
      hints.push(`${nodeID || metadata.displayName} moves from a later phase back to ${metadata.phase}; that is allowed, but check the data flow.`);
    }
    if (phaseIndex >= 0) {
      lastPhaseIndex = Math.max(lastPhaseIndex, phaseIndex);
    }
  });

  if (!hasTarget) {
    hints.push("Consider starting with a target node so the run has an explicit source or work set.");
  }
  if (!hasCommit) {
    hints.push("This workflow has no commit node; it may inspect or materialize data without persisting library state.");
  }
  return hints.slice(0, 5);
}

function storedWorkflowView(): WorkflowView {
  const value = readSessionValue(workflowViewStorageKey);
  return value === "scheduled" ? value : "definitions";
}

function storedPositiveInt(key: string) {
  const value = Number(readSessionValue(key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function readSessionValue(key: string) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeSessionValue(key: string, value: string | null) {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
    }
  } catch {
    // Storage can be unavailable in restricted browsing contexts.
  }
}

function storePositiveInt(key: string, value: number | null) {
  storeSessionValue(key, value && value > 0 ? String(value) : null);
}

function switchActivityView(
  view: ActivityView,
  surface: Surface,
  setActivityView: (view: ActivityView) => void,
  setRunPage: (page: number) => void,
  setSelectedRunID: (id: number | null) => void,
  setRunDetailView: (view: RunDetailView) => void,
) {
  if (surface === "activity") {
    const path = view === "running" ? "/activity" : `/activity?view=${encodeURIComponent(view)}`;
    window.history.pushState({}, "", path);
  }
  setActivityView(view);
  setRunPage(1);
  setSelectedRunID(null);
  setRunDetailView(view === "logs" ? "logs" : view === "review" ? "items" : "overview");
}

function activityViewFromLocation(): ActivityView {
  const value = new URLSearchParams(window.location.search).get("view");
  return activityViews.includes(value as ActivityView) ? value as ActivityView : "running";
}

function reviewCount(run: WorkflowRun) {
  return run.pendingCandidates + run.skippedNodeRuns + run.skippedJobs + (run.status === "partial" || run.status === "skipped" ? 1 : 0);
}

function candidateNeedsReview(candidate: WorkflowCandidate) {
  return !["accepted", "rejected", "ignored", "resolved"].includes(candidate.status);
}

type LocalCleanupLocation = { locationId: number; path: string; sizeBytes: number | null };
type LocalDuplicateFolder = { relPath: string; files: number; audioFiles: number; sizeBytes: number | null };
type LocalArchivedRoot = { folderId: number; originalPath: string; archivePath: string; fileCount: number; sizeBytes: number | null; files: Array<{ path: string; sizeBytes: number | null }> };

function parseJSONRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function localCleanupLocations(payload: Record<string, unknown>): LocalCleanupLocation[] {
  const locations = Array.isArray(payload.candidate_locations) ? payload.candidate_locations : [];
  return locations.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const locationId = numberValue(record.location_id);
    const path = stringValue(record.path);
    if (!locationId || !path) return [];
    return [{ locationId, path, sizeBytes: nullableNumberValue(record.size_bytes) }];
  });
}

function localArchivedRoots(payload: Record<string, unknown>): LocalArchivedRoot[] {
  const roots = Array.isArray(payload.archived_roots) ? payload.archived_roots : [];
  return roots.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const folderId = numberValue(record.folder_id);
    const originalPath = stringValue(record.original_path);
    const archivePath = stringValue(record.archive_path);
    if (!folderId || !originalPath || !archivePath) return [];
    const files = Array.isArray(record.files) ? record.files.flatMap((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file)) return [];
      const item = file as Record<string, unknown>;
      const path = stringValue(item.path);
      return path ? [{ path, sizeBytes: nullableNumberValue(item.size_bytes) }] : [];
    }) : [];
    return [{ folderId, originalPath, archivePath, fileCount: numberValue(record.file_count) ?? files.length, sizeBytes: nullableNumberValue(record.size_bytes), files }];
  });
}

function localDuplicateFolders(payload: Record<string, unknown>): LocalDuplicateFolder[] {
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  return folders.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const relPath = stringValue(record.rel_path);
    if (!relPath) return [];
    return [{
      relPath,
      files: numberValue(record.files) ?? 0,
      audioFiles: numberValue(record.audio_files) ?? 0,
      sizeBytes: nullableNumberValue(record.size_bytes),
    }];
  });
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableNumberValue(value: unknown) {
  const number = numberValue(value);
  return number === null ? null : number;
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function nodeSubtitle(type: string, nodeTypes: WorkflowNodeType[]) {
  const metadata = nodeTypes.find((nodeType) => nodeType.type === type);
  return metadata ? `${metadata.phase} · ${type}` : type;
}

function schemaFields(schemaJson: string) {
  const fields = schemaFieldNames(schemaJson);
  return fields.length > 0 ? fields.join(", ") : "none";
}

function schemaFieldNames(schemaJson: string) {
  try {
    const parsed = JSON.parse(schemaJson) as { properties?: Record<string, unknown> };
    return Object.keys(parsed.properties ?? {});
  } catch {
    return [];
  }
}

function configFieldKind(field: string) {
  if (/^(is|has|can)[A-Z_]/.test(field) || /enabled|overwrite|dryRun|force|include|mark|delete|clear|check/i.test(field)) {
    return "boolean";
  }
  if (/count|limit|size|depth|days|page|minutes|seconds|gb|no$/i.test(field)) {
    return "number";
  }
  return "text";
}

function formatConfigInputValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value === undefined || value === null || typeof value === "object") {
    return "";
  }
  return String(value);
}

function parseConfigInputValue(value: string, kind: string, field: string) {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }
  if (kind === "number") {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  if (/(ids|codes|paths)$/i.test(field) || trimmed.includes(",")) {
    return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return value;
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

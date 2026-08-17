import {
  Activity,
  AlertCircle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Edit3,
  Eye,
  ExternalLink,
  FileJson,
  GitBranchPlus,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { activityViewForRun, type ActivityView } from "@/features/workflows/activityModel";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useAuth } from "@/auth/AuthProvider";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { WorkflowCanvas } from "@/features/workflows/WorkflowCanvas";
import { WorkflowComposer } from "@/features/workflows/WorkflowComposer";
import {
  parseWorkflowDefinition,
  upgradeLegacyWorkflowDefinition,
  workflowDefinitionNodeCount,
  type WorkflowInputDefinition,
} from "@/features/workflows/definitionModel";
import { WorkflowRunDialog } from "@/features/workflows/WorkflowRunDialog";
import { parseWorkCodes, WorkCodesField } from "@/features/workflows/WorkCodesField";
import { WorkflowViewportTools } from "@/features/workflows/WorkflowViewportTools";
import {
  workflowDataTypeColor,
  workflowEdgeClassName,
  type WorkflowEdgeVisualState,
} from "@/features/workflows/workflowVisuals";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { useDeferredBusy } from "@/hooks/useDeferredBusy";
import {
  api,
  type LibrarySource,
  type AvailabilityWatch,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowDefinition,
  type WorkflowNodeType,
  type WorkflowNodeRun,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunGraph,
  type WorkflowRunsPage,
  type WorkflowTrigger,
} from "@/lib/api";
import { currentScopedStorageKey } from "@/lib/clientStorageScope";

type Surface = "workflows" | "activity";
type ModalMode = "create-workflow" | "edit-workflow" | "edit-node" | "create-trigger" | "edit-trigger" | null;
type AutomationTriggerType = "startup" | "filesystem_event" | "schedule";
type CreatableAutomationTriggerType = Exclude<AutomationTriggerType, "filesystem_event">;

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
  {
    type: "select_works",
    phase: "target",
    displayName: "Select works",
    description: "Choose known works.",
    userVisible: true,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
  {
    type: "select_ranking",
    phase: "target",
    displayName: "Configure ranking",
    description: "Choose a ranking period.",
    userVisible: false,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
  {
    type: "discover_provider_ranking",
    phase: "discover",
    displayName: "Discover provider ranking",
    description: "Fetch an ordered provider ranking.",
    userVisible: false,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
  {
    type: "filter_candidates",
    phase: "filter",
    displayName: "Filter candidates",
    description: "Filter workflow candidates.",
    userVisible: true,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
  {
    type: "sync_metadata",
    phase: "commit",
    displayName: "Sync metadata",
    description: "Persist metadata.",
    userVisible: true,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
  {
    type: "assign_user_tags",
    phase: "commit",
    displayName: "Assign user tags",
    description: "Append user-owned tags.",
    userVisible: false,
    configSchema: "{}",
    inputSchema: "{}",
    outputSchema: "{}",
  },
];

const phaseOrder = ["target", "discover", "filter", "match", "plan", "execute", "verify", "commit"] as const;

const automationTriggerTypes: CreatableAutomationTriggerType[] = ["startup", "schedule"];
const activityViews: ActivityView[] = ["running", "review", "failed", "completed"];
const emptyRunViewTotals = { running: 0, review: 0, failed: 0, completed: 0 };
const workflowDefinitionStorageBaseKey = "kikoto.workflows.definition:v2";
const workflowDefinitionTabStorageBaseKey = "kikoto.workflows.definition-tab:v1";
type WorkflowDefinitionTab = "built-in" | "custom";

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

type SystemRunOptions = {
  followUpRun?: boolean;
};

type DLsitePopularPeriod = "day" | "week" | "month" | "year";

type DLsitePopularRunOptions = {
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
};

type RemotePopularRunOptions = {
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  tagNameTemplate: string;
};

type WorkflowTagTemplateToken = {
  name: string;
  description: string;
  value: string;
};

type WorkflowTagTemplatePreview = {
  value: string;
  renderedLength: number;
  truncated: boolean;
};

const TAG_TEMPLATE_MAX_LENGTH = 160;
const TAG_NAME_MAX_LENGTH = 40;
const REMOTE_POPULAR_TAG_TEMPLATE = "{date}_{remote_name}_popular";

type SystemWorkflowTriggerConfig = {
  followUpRun: boolean;
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
};

const manuallyRunnableSystemWorkflows: Record<string, SystemRunKind[]> = {
  availability_watch: [],
  local_library_scan: ["local_scan"],
  metadata_sync: ["metadata_sync"],
  remote_popular_collection: ["remote_popular"],
  dlsite_popular_collection: ["dlsite_popular"],
};

const configurableSystemWorkflowCodes = new Set(Object.keys(manuallyRunnableSystemWorkflows));

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
  readOnly = false,
}: {
  surface: Surface;
  canRun: boolean;
  canSyncMetadata: boolean;
  canTagWorks: boolean;
  canManageDownloads: boolean;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const auth = useAuth();
  const workflowDefinitionStorageKey = currentScopedStorageKey(workflowDefinitionStorageBaseKey, auth.user?.id ?? null);
  const workflowDefinitionTabStorageKey = currentScopedStorageKey(
    workflowDefinitionTabStorageBaseKey,
    auth.user?.id ?? null,
  );
  const [definitionTab, setDefinitionTab] = useState<WorkflowDefinitionTab>(() =>
    window.localStorage.getItem(workflowDefinitionTabStorageKey) === "custom" ? "custom" : "built-in",
  );
  const definitionSelectionKey = `${workflowDefinitionStorageKey}:${definitionTab}`;
  const [activityView, setActivityView] = useState<ActivityView>(() => activityViewFromLocation());
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [nodeTypes, setNodeTypes] = useState<WorkflowNodeType[]>(fallbackNodeTypes);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runsPage, setRunsPage] = useState<WorkflowRunsPage>({
    runs: [],
    page: 1,
    pageSize: 10,
    total: 0,
    viewTotals: emptyRunViewTotals,
  });
  const [runsView, setRunsView] = useState<ActivityView | null>(null);
  const [runPage, setRunPage] = useState(1);
  const [runQuery, setRunQuery] = useState("");
  const [selectedDefinitionId, setSelectedDefinitionID] = useState<number | null>(() =>
    storedPositiveInt(
      `${workflowDefinitionStorageKey}:${window.localStorage.getItem(workflowDefinitionTabStorageKey) === "custom" ? "custom" : "built-in"}`,
    ),
  );
  const [selectedRunId, setSelectedRunID] = useState<number | null>(() => activityRunIDFromLocation());
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingNodeIndex, setEditingNodeIndex] = useState<number | null>(null);
  const [editingTrigger, setEditingTrigger] = useState<WorkflowTrigger | null>(null);
  const [creatingTriggerType, setCreatingTriggerType] = useState<CreatableAutomationTriggerType>("schedule");
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);
  const [runningSystemAction, setRunningSystemAction] = useState<SystemRunKind | null>(null);
  const [isWorkflowMetaLoading, setIsWorkflowMetaLoading] = useState(true);
  const [hasWorkflowMetaSnapshot, setHasWorkflowMetaSnapshot] = useState(false);
  const [workflowMetaError, setWorkflowMetaError] = useState("");
  const [isRunsLoading, setIsRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState("");
  const [recentDefinitionRuns, setRecentDefinitionRuns] = useState<WorkflowRun[]>([]);
  const [workflowLaunch, setWorkflowLaunch] = useState<{
    definition: WorkflowDefinition;
    inputs: Record<string, unknown>;
    autoPreview: boolean;
  } | null>(null);
  const workflowMetaRequestSeq = useRef(0);
  const runsRequestSeq = useRef(0);
  const runsAbortController = useRef<AbortController | null>(null);

  const refresh = () => {
    const seq = ++workflowMetaRequestSeq.current;
    setIsWorkflowMetaLoading(true);
    setWorkflowMetaError("");
    Promise.all([api.listWorkflowDefinitions(), api.listWorkflowNodeTypes(), api.listWorkflowTriggers()])
      .then(([nextDefinitions, nextNodeTypes, nextTriggers]) => {
        if (seq !== workflowMetaRequestSeq.current) return;
        setDefinitions(nextDefinitions);
        setNodeTypes(nextNodeTypes);
        setTriggers(nextTriggers);
        setHasWorkflowMetaSnapshot(true);
      })
      .catch(() => {
        if (seq === workflowMetaRequestSeq.current) setWorkflowMetaError("Workflow data could not be loaded.");
      })
      .finally(() => {
        if (seq === workflowMetaRequestSeq.current) setIsWorkflowMetaLoading(false);
      });
  };

  const refreshRuns = (page: number, view: ActivityView, query: string) => {
    const seq = ++runsRequestSeq.current;
    runsAbortController.current?.abort();
    const controller = new AbortController();
    runsAbortController.current = controller;
    setIsRunsLoading(true);
    setRunsError("");
    api
      .listWorkflowRuns(page, 10, view, query, "", controller.signal)
      .then((next) => {
        if (seq !== runsRequestSeq.current) return;
        setRunsPage(next);
        setRuns(next.runs);
        setRunsView(view);
      })
      .catch(() => {
        if (!controller.signal.aborted && seq === runsRequestSeq.current) {
          setRunsError("Activity could not be loaded.");
        }
      })
      .finally(() => {
        if (seq === runsRequestSeq.current) setIsRunsLoading(false);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (surface !== "activity") {
      runsAbortController.current?.abort();
      setIsRunsLoading(false);
      return;
    }
    refreshRuns(runPage, activityView, runQuery);
    return () => runsAbortController.current?.abort();
  }, [activityView, runPage, surface]);

  useEffect(() => {
    if (surface !== "activity") return;
    const syncView = () => {
      const next = activityViewFromLocation();
      setActivityView(next);
      setRunPage(1);
      setSelectedRunID(activityRunIDFromLocation());
    };
    syncView();
    window.addEventListener("popstate", syncView);
    window.addEventListener("kikoto:navigation", syncView);
    return () => {
      window.removeEventListener("popstate", syncView);
      window.removeEventListener("kikoto:navigation", syncView);
    };
  }, [surface]);

  const visibleDefinitions = useMemo(() => {
    return definitions.filter(
      (definition) => definition.scope === "user" || configurableSystemWorkflowCodes.has(definition.code),
    );
  }, [definitions]);
  const tabDefinitions = useMemo(
    () =>
      visibleDefinitions.filter((definition) =>
        definitionTab === "built-in" ? definition.scope === "system" : definition.scope === "user",
      ),
    [definitionTab, visibleDefinitions],
  );
  const visibleRuns = surface === "activity" && runsView !== activityView ? [] : runs;
  const activityTotals = runsPage.viewTotals ?? emptyRunViewTotals;
  const selectedDefinition = useMemo(() => {
    return tabDefinitions.find((definition) => definition.id === selectedDefinitionId) ?? tabDefinitions[0] ?? null;
  }, [selectedDefinitionId, tabDefinitions]);

  useEffect(() => {
    if (surface !== "workflows" || visibleDefinitions.length === 0) return;
    const syncLinkedWorkflow = () => {
      const code = new URLSearchParams(window.location.search).get("workflow")?.trim();
      if (!code) return;
      const linked = visibleDefinitions.find((definition) => definition.code === code);
      if (!linked) return;
      const tab = linked.scope === "system" ? "built-in" : "custom";
      setDefinitionTab(tab);
      window.localStorage.setItem(workflowDefinitionTabStorageKey, tab);
      setSelectedDefinitionID(linked.id);
      storePositiveInt(`${workflowDefinitionStorageKey}:${tab}`, linked.id);
    };
    syncLinkedWorkflow();
    window.addEventListener("popstate", syncLinkedWorkflow);
    window.addEventListener("kikoto:navigation", syncLinkedWorkflow);
    return () => {
      window.removeEventListener("popstate", syncLinkedWorkflow);
      window.removeEventListener("kikoto:navigation", syncLinkedWorkflow);
    };
  }, [surface, visibleDefinitions, workflowDefinitionStorageKey, workflowDefinitionTabStorageKey]);

  const refreshRecentRuns = (workflowCode: string) => {
    if (surface !== "workflows" || !workflowCode) {
      setRecentDefinitionRuns([]);
      return Promise.resolve();
    }
    return api
      .listWorkflowRuns(1, 5, "", "", workflowCode)
      .then((page) => setRecentDefinitionRuns(page.runs))
      .catch(() => undefined);
  };

  useEffect(() => {
    if (surface !== "workflows" || !selectedDefinition) {
      setRecentDefinitionRuns([]);
      return;
    }
    void refreshRecentRuns(selectedDefinition.code);
  }, [selectedDefinition?.code, surface]);

  const hasActiveRecentRun = recentDefinitionRuns.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => {
    if (surface !== "workflows" || !selectedDefinition || !hasActiveRecentRun) return;
    const timer = window.setInterval(() => void refreshRecentRuns(selectedDefinition.code), 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveRecentRun, selectedDefinition?.code, surface]);

  const selectedRunSummary =
    visibleRuns.find((run) => run.id === selectedRunId) ?? (selectedRunId === null ? (visibleRuns[0] ?? null) : null);
  const selectedActivityRunID = selectedRunId ?? selectedRunSummary?.id ?? null;
  const waitingForInitialRuns =
    surface === "activity" && isRunsLoading && visibleRuns.length === 0 && selectedActivityRunID === null;
  const showRunsLoading = useDeferredBusy(waitingForInitialRuns);
  const activityRun = useWorkflowRunWatcher(surface === "activity" ? selectedActivityRunID : null);
  const previousActivityRunView = useRef<ActivityView | null>(null);
  const selectedSystemRunKinds = selectedDefinition
    ? manuallyRunnableSystemWorkflows[selectedDefinition.code]
    : undefined;
  const definitionEmptyText = "No runnable or custom workflow definitions exist yet.";

  useEffect(() => {
    if (isWorkflowMetaLoading) return;
    const nextID = selectedDefinition?.id ?? null;
    if (selectedDefinitionId !== nextID) {
      setSelectedDefinitionID(nextID);
    }
    storePositiveInt(definitionSelectionKey, nextID);
  }, [isWorkflowMetaLoading, selectedDefinition?.id, selectedDefinitionId]);

  const selectDefinition = (definition: WorkflowDefinition) => {
    setSelectedDefinitionID(definition.id);
    storePositiveInt(
      `${workflowDefinitionStorageKey}:${definition.scope === "system" ? "built-in" : "custom"}`,
      definition.id,
    );
    const search = new URLSearchParams(window.location.search);
    if (search.has("workflow")) {
      search.delete("workflow");
      search.delete("dialog");
      search.delete("run");
      window.history.replaceState(window.history.state, "", `/workflows${search.size > 0 ? `?${search}` : ""}`);
    }
  };

  const selectDefinitionTab = (tab: WorkflowDefinitionTab) => {
    setDefinitionTab(tab);
    window.localStorage.setItem(workflowDefinitionTabStorageKey, tab);
    setSelectedDefinitionID(storedPositiveInt(`${workflowDefinitionStorageKey}:${tab}`));
  };

  useEffect(() => {
    if (!activityRun.run) return;
    setRuns((items) => items.map((item) => (item.id === activityRun.run?.id ? { ...item, ...activityRun.run } : item)));
  }, [activityRun.run]);

  useEffect(() => {
    if (surface !== "activity" || !activityRun.run) {
      previousActivityRunView.current = null;
      return;
    }
    const nextView = activityViewForRun(activityRun.run);
    const previousView = previousActivityRunView.current;
    previousActivityRunView.current = nextView;
    if (!previousView || previousView === nextView) return;
    setActivityView(nextView);
    setRunPage(1);
    const search = new URLSearchParams({ view: nextView, run: String(activityRun.run.id) });
    window.history.replaceState(window.history.state, "", `/activity?${search}`);
  }, [activityRun.run, runQuery, surface]);

  useEffect(() => {
    const linkedRunID = activityRunIDFromLocation();
    if (
      surface !== "activity" ||
      !activityRun.run ||
      linkedRunID !== activityRun.run.id ||
      new URLSearchParams(window.location.search).has("view")
    )
      return;
    const nextView = activityViewForRun(activityRun.run);
    setActivityView(nextView);
    setRunPage(1);
    const search = new URLSearchParams({ view: nextView, run: String(activityRun.run.id) });
    window.history.replaceState(window.history.state, "", `/activity?${search}`);
  }, [activityRun.run, surface]);

  const runLocalScan = async (followUpRun = false) => {
    setIsRunningScan(true);
    try {
      const result = await api.runLocalScan({ followUpRun });
      toast.success(`Local scan run #${result.runId} created.`);
      void refreshRecentRuns("local_library_scan");
    } catch (error) {
      toast.notify(toastFromError(error, "Local scan run could not be created."));
    } finally {
      setIsRunningScan(false);
    }
  };

  const runMetadataSync = async () => {
    setIsSyncingMetadata(true);
    try {
      const result = await api.runDLsiteSync();
      toast.success(`Metadata sync run #${result.runId} created.`);
      void refreshRecentRuns("metadata_sync");
    } catch (error) {
      toast.notify(toastFromError(error, "Metadata sync run could not be created."));
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
    } catch (error) {
      toast.notify(toastFromError(error, "DLsite popular collection could not be queued."));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runSystemAction = async (kind: SystemRunKind, options: SystemRunOptions = {}) => {
    if (kind === "local_scan") return runLocalScan(options.followUpRun ?? false);
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
    if (readOnly) return false;
    if (kind === "local_scan" || kind === "metadata_sync") return canRun && canSyncMetadata;
    if (kind === "dlsite_popular") return canRun && canSyncMetadata && canTagWorks;
    if (kind === "remote_popular") return canRun && canTagWorks;
    return canRun;
  };

  const createAutomationTrigger = (triggerType: CreatableAutomationTriggerType) => {
    setCreatingTriggerType(triggerType);
    setEditingTrigger(null);
    setModalMode("create-trigger");
  };

  const editAutomationTrigger = (trigger: WorkflowTrigger) => {
    setEditingTrigger(trigger);
    setModalMode("edit-trigger");
  };

  const toggleAutomationTrigger = async (trigger: WorkflowTrigger, enabled: boolean) => {
    setTriggers((current) => current.map((item) => (item.id === trigger.id ? { ...item, enabled } : item)));
    try {
      const saved = await api.updateWorkflowTrigger(trigger.id, {
        workflowDefinitionId: trigger.workflowDefinitionId,
        displayName: trigger.displayName,
        triggerType: trigger.triggerType,
        enabled,
        scheduleJson: trigger.scheduleJson,
        configJson: trigger.configJson,
        nextRunAt: null,
      });
      setTriggers((current) => current.map((item) => (item.id === saved.id ? saved : item)));
    } catch (error) {
      setTriggers((current) => current.map((item) => (item.id === trigger.id ? trigger : item)));
      toast.notify(toastFromError(error, `Could not ${enabled ? "enable" : "pause"} trigger.`));
    }
  };

  const refreshSelectedRunReview = async () => {
    if (!selectedActivityRunID) return;
    await activityRun.refresh(true);
    refreshRuns(runPage, activityView, runQuery);
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
      {readOnly && (
        <div
          className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          Demo mode is read-only. Workflow definitions, schedules, runs, and reviews cannot be changed.
        </div>
      )}
      {surface === "workflows" && hasWorkflowMetaSnapshot && workflowMetaError && (
        <div
          className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
          role="alert"
        >
          <span className="text-sm text-destructive">{workflowMetaError} Existing workflow data is still shown.</span>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}

      {surface === "workflows" ? (
        <Workbench
          left={
            <DefinitionSidebar
              definitions={visibleDefinitions}
              triggers={triggers}
              selectedId={selectedDefinition?.id ?? null}
              canCreate
              activeTab={definitionTab}
              loading={isWorkflowMetaLoading && !hasWorkflowMetaSnapshot}
              error={!hasWorkflowMetaSnapshot ? workflowMetaError : ""}
              emptyText={definitionEmptyText}
              onSelect={selectDefinition}
              onTabChange={selectDefinitionTab}
              onRetry={refresh}
              onCreate={() => setModalMode("create-workflow")}
            />
          }
          right={
            !hasWorkflowMetaSnapshot && isWorkflowMetaLoading ? (
              <WorkflowMetadataLoadingState />
            ) : !hasWorkflowMetaSnapshot && workflowMetaError ? (
              <WorkflowMetadataErrorState message={workflowMetaError} onRetry={refresh} />
            ) : selectedDefinition?.code === "availability_watch" ? (
              <AvailabilityWatchPanel
                definition={selectedDefinition}
                triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === selectedDefinition.id)}
                nodeTypes={nodeTypes}
                recentRuns={recentDefinitionRuns}
                readOnly={readOnly}
                canManageDownloads={canManageDownloads}
                onCreateTrigger={createAutomationTrigger}
                onEditTrigger={editAutomationTrigger}
                onToggleTrigger={toggleAutomationTrigger}
                onOpenRun={openActivityRun}
                onRunQueued={() => void refreshRecentRuns("availability_watch")}
              />
            ) : (
              <WorkflowDetail
                definition={selectedDefinition}
                definitionTriggers={triggers.filter(
                  (trigger) => trigger.workflowDefinitionId === selectedDefinition?.id,
                )}
                nodeTypes={nodeTypes}
                readonly={readOnly || !selectedDefinition?.editable}
                canManageTriggers={!readOnly}
                systemRunKinds={selectedSystemRunKinds}
                isSystemActionRunning={systemActionBusy}
                canRunSystemAction={systemActionAllowed}
                onRunSystemAction={runSystemAction}
                onRunRemotePopular={runPopularCollection}
                canFetchRemotePopular={canManageDownloads}
                onRunDLsitePopular={runDLsitePopularCollection}
                recentRuns={recentDefinitionRuns}
                onOpenRun={openActivityRun}
                onRunDefinition={
                  !readOnly && selectedDefinition?.scope === "user"
                    ? (inputs = {}, autoPreview = false) =>
                        setWorkflowLaunch({ definition: selectedDefinition, inputs, autoPreview })
                    : undefined
                }
                onCreateTrigger={createAutomationTrigger}
                onEditTrigger={editAutomationTrigger}
                onToggleTrigger={toggleAutomationTrigger}
                emptyText={definitionEmptyText}
                onEditDefinition={() => setModalMode("edit-workflow")}
                onEditNode={(index) => {
                  setEditingNodeIndex(index);
                  setModalMode("edit-node");
                }}
              />
            )
          }
        />
      ) : (
        <>
          <SegmentedNav compact>
            <ViewButton
              active={activityView === "running"}
              count={activityTotals.running}
              onClick={() => switchActivityView("running", surface, setActivityView, setRunPage, setSelectedRunID)}
              icon={<Activity className="h-4 w-4" />}
            >
              Running
            </ViewButton>
            <ViewButton
              active={activityView === "review"}
              count={activityTotals.review}
              onClick={() => switchActivityView("review", surface, setActivityView, setRunPage, setSelectedRunID)}
              icon={<FileJson className="h-4 w-4" />}
            >
              Review
            </ViewButton>
            <ViewButton
              active={activityView === "failed"}
              count={activityTotals.failed}
              onClick={() => switchActivityView("failed", surface, setActivityView, setRunPage, setSelectedRunID)}
              icon={<AlertCircle className="h-4 w-4" />}
            >
              Failed
            </ViewButton>
            <ViewButton
              active={activityView === "completed"}
              count={activityTotals.completed}
              mobileLabel="Done"
              onClick={() => switchActivityView("completed", surface, setActivityView, setRunPage, setSelectedRunID)}
              icon={<ListChecks className="h-4 w-4" />}
            >
              Completed
            </ViewButton>
          </SegmentedNav>
          <ActivityToolbar
            query={runQuery}
            onQueryChange={setRunQuery}
            onSearch={() => {
              setSelectedRunID(null);
              if (runPage === 1) refreshRuns(1, activityView, runQuery);
              else setRunPage(1);
            }}
            onRecoverStale={recoverStaleRuns}
            readOnly={readOnly}
          />
          {runsError && (visibleRuns.length > 0 || selectedActivityRunID !== null) && (
            <div
              className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
              role="alert"
            >
              <span className="text-sm text-destructive">{runsError} Existing activity is still shown.</span>
              <Button size="sm" variant="outline" onClick={() => refreshRuns(runPage, activityView, runQuery)}>
                Retry
              </Button>
            </div>
          )}
          {waitingForInitialRuns || showRunsLoading ? (
            showRunsLoading ? (
              <ActivityLoadingState />
            ) : (
              <ActivityPendingState />
            )
          ) : runsError && visibleRuns.length === 0 && selectedActivityRunID === null ? (
            <ActivityErrorState message={runsError} onRetry={() => refreshRuns(runPage, activityView, runQuery)} />
          ) : visibleRuns.length === 0 && selectedActivityRunID === null ? (
            <ActivityEmptyState view={activityView} filtered={Boolean(runQuery.trim())} />
          ) : (
            <Workbench
              left={
                <RunSidebar
                  runs={visibleRuns}
                  selectedId={selectedActivityRunID}
                  page={runsPage.page}
                  pageSize={runsPage.pageSize}
                  total={runsPage.total}
                  loading={isRunsLoading}
                  onSelect={(run) => selectActivityRun(run, activityView, setSelectedRunID)}
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
              right={
                <RunDetail
                  run={activityRun.run ?? selectedRunSummary}
                  events={activityRun.events}
                  candidates={activityRun.candidates}
                  nodeTypes={nodeTypes}
                  loading={activityRun.loading && !activityRun.run}
                  onCandidateUpdate={refreshSelectedRunReview}
                  onRunAction={refreshSelectedRunReview}
                  readOnly={readOnly}
                />
              }
            />
          )}
        </>
      )}

      {modalMode === "create-workflow" && (
        <WorkflowComposer
          definition={null}
          nodeTypes={nodeTypes}
          readOnly={readOnly}
          onClose={() => setModalMode(null)}
          onSaved={(definition) => {
            selectDefinition(definition);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {modalMode === "edit-workflow" &&
        selectedDefinition &&
        parseWorkflowDefinition(selectedDefinition.definitionJson).kind === "v2" && (
          <WorkflowComposer
            definition={selectedDefinition}
            triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === selectedDefinition.id)}
            nodeTypes={nodeTypes}
            readOnly={readOnly}
            onClose={() => setModalMode(null)}
            onDeleted={() => {
              const deletedID = selectedDefinition.id;
              const deletedName = selectedDefinition.displayName;
              setDefinitions((current) => current.filter((definition) => definition.id !== deletedID));
              setSelectedDefinitionID(null);
              setModalMode(null);
              refresh();
              toast.success(`${deletedName} deleted.`);
            }}
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
      {modalMode === "create-trigger" && selectedDefinition && (
        <TriggerModal
          definition={selectedDefinition}
          trigger={null}
          initialTriggerType={creatingTriggerType}
          onClose={() => setModalMode(null)}
          onSaved={() => {
            setModalMode(null);
            refresh();
          }}
          onDeleted={() => undefined}
        />
      )}
      {modalMode === "edit-trigger" && selectedDefinition && editingTrigger && (
        <TriggerModal
          definition={selectedDefinition}
          trigger={editingTrigger}
          initialTriggerType={editingTrigger.triggerType === "startup" ? "startup" : "schedule"}
          onClose={() => setModalMode(null)}
          onSaved={() => {
            setModalMode(null);
            refresh();
          }}
          onDeleted={() => {
            setEditingTrigger(null);
            setModalMode(null);
            refresh();
          }}
        />
      )}
      {workflowLaunch && (
        <WorkflowRunDialog
          definition={workflowLaunch.definition}
          initialInputs={workflowLaunch.inputs}
          autoPreview={workflowLaunch.autoPreview}
          onClose={() => setWorkflowLaunch(null)}
          onQueued={(runId) => {
            setWorkflowLaunch(null);
            window.history.pushState({}, "", `/activity?view=running&run=${runId}`);
            window.dispatchEvent(new Event("kikoto:navigation"));
          }}
        />
      )}
    </div>
  );
}

function Workbench({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

type AvailabilityWatchDialog = "configure" | "monitoring" | "ready" | null;

function AvailabilityWatchPanel({
  definition,
  triggers,
  nodeTypes,
  recentRuns,
  readOnly,
  canManageDownloads,
  onCreateTrigger,
  onEditTrigger,
  onToggleTrigger,
  onOpenRun,
  onRunQueued,
}: {
  definition: WorkflowDefinition;
  triggers: WorkflowTrigger[];
  nodeTypes: WorkflowNodeType[];
  recentRuns: WorkflowRun[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType) => void;
  onEditTrigger: (trigger: WorkflowTrigger) => void;
  onToggleTrigger: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
  onOpenRun: (run: WorkflowRun) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const [watch, setWatch] = useState<AvailabilityWatch | null>(null);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [dialog, setDialog] = useState<AvailabilityWatchDialog>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const refreshWatch = async () => {
    const next = await api.getAvailabilityWatch();
    setWatch(next);
    setLoadError("");
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getAvailabilityWatch(), api.listLibrarySources()])
      .then(([next, nextSources]) => {
        if (cancelled) return;
        setWatch(next);
        setSources(
          nextSources.filter(
            (source) =>
              source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
          ),
        );
        setLoadError("");
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Availability Watch could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const syncDialog = () => {
      const search = new URLSearchParams(window.location.search);
      if (search.get("workflow") === "availability_watch" && search.get("dialog") === "ready") {
        setDialog("ready");
      }
    };
    syncDialog();
    window.addEventListener("popstate", syncDialog);
    window.addEventListener("kikoto:navigation", syncDialog);
    return () => {
      window.removeEventListener("popstate", syncDialog);
      window.removeEventListener("kikoto:navigation", syncDialog);
    };
  }, []);

  useEffect(() => {
    if (!watch) return;
    const timer = window.setInterval(() => void refreshWatch().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [watch?.id]);

  const openReady = () => {
    const search = new URLSearchParams(window.location.search);
    search.set("workflow", "availability_watch");
    search.set("dialog", "ready");
    search.delete("run");
    window.history.replaceState(window.history.state, "", `/workflows?${search}`);
    setDialog("ready");
  };
  const closeDialog = () => {
    if (dialog === "ready") {
      const search = new URLSearchParams(window.location.search);
      search.set("workflow", "availability_watch");
      search.delete("dialog");
      search.delete("run");
      window.history.replaceState(window.history.state, "", `/workflows?${search}`);
    }
    setDialog(null);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5">
          <SkeletonLine className="h-6 w-48" />
          <SkeletonLine className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (!watch || loadError) {
    return <WorkflowMetadataErrorState message={loadError || "Availability Watch could not be loaded."} onRetry={() => void refreshWatch()} />;
  }

  const monitoring = watch.targets.filter((target) => target.state === "monitoring" || target.state === "error");
  const ready = watch.targets.filter(
    (target) => target.state !== "monitoring" && target.state !== "error" && target.state !== "disabled",
  );
  const nodes = parseNodes(definition.definitionJson);

  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 space-y-5 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold">{definition.displayName}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{definition.code}</span>
              <span>{nodes.length} nodes</span>
              <span>
                {triggers.length} trigger{triggers.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <Button size="sm" onClick={() => setDialog("configure")} disabled={readOnly}>
            <Settings2 className="h-4 w-4" />
            Configure
          </Button>
        </div>

        <section className="grid border-y sm:grid-cols-2" aria-label="Availability pools">
          <div className="flex min-w-0 items-center justify-between gap-3 py-4 sm:pr-5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Monitoring</div>
              <div className="mt-1 text-2xl font-semibold">{monitoring.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDialog("monitoring")} disabled={readOnly}>
              <Edit3 className="h-4 w-4" />
              Edit
            </Button>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 border-t py-4 sm:border-l sm:border-t-0 sm:pl-5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Ready</div>
              <div className="mt-1 text-2xl font-semibold">{ready.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={openReady}>
              <Eye className="h-4 w-4" />
              View
            </Button>
          </div>
        </section>

        <WorkflowAutomationPanel
          definition={definition}
          triggers={triggers}
          canManage={!readOnly}
          onCreate={onCreateTrigger}
          onEdit={onEditTrigger}
          onToggle={onToggleTrigger}
        />

        <DefinitionNodeCanvas nodes={nodes} nodeTypes={nodeTypes} readonly onEditNode={() => undefined} />
        <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />
      </CardContent>

      {dialog === "configure" && (
        <AvailabilityWatchConfigureDialog
          watch={watch}
          sources={sources}
          readOnly={readOnly}
          canManageDownloads={canManageDownloads}
          onClose={closeDialog}
          onSaved={setWatch}
          onRunQueued={onRunQueued}
        />
      )}
      {dialog === "monitoring" && (
        <AvailabilityWatchMonitoringDialog
          watch={watch}
          readOnly={readOnly}
          onClose={closeDialog}
          onSaved={setWatch}
        />
      )}
      {dialog === "ready" && (
        <AvailabilityWatchReadyDialog
          targets={ready}
          readOnly={readOnly}
          onClose={closeDialog}
          onChanged={() => void refreshWatch().catch((error) => toast.notify(toastFromError(error, "Ready pool could not be refreshed.")))}
        />
      )}
    </Card>
  );
}

function AvailabilityWatchConfigureDialog({
  watch,
  sources,
  readOnly,
  canManageDownloads,
  onClose,
  onSaved,
  onRunQueued,
}: {
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onClose: () => void;
  onSaved: (watch: AvailabilityWatch) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const [action, setAction] = useState<AvailabilityWatch["action"]>(watch.action);
  const [sourceId, setSourceId] = useState(watch.sourceId ?? 0);
  const [excluded, setExcluded] = useState(watch.excludeExtensions.join(", "));
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const [error, setError] = useState("");

  const save = async (runNow: boolean) => {
    setBusy(runNow ? "run" : "save");
    setError("");
    try {
      const next = await api.updateAvailabilityWatch({
        action,
        sourceId: sourceId || null,
        excludeExtensions: excluded
          .split(/[\s,;，；]+/u)
          .map((value) => value.trim())
          .filter(Boolean),
      });
      onSaved(next);
      if (runNow) {
        const result = await api.runAvailabilityWatch();
        toast.success(`Availability Watch run #${result.runId} queued.`);
        onRunQueued();
      } else {
        toast.success("Availability Watch configuration saved.");
      }
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Availability Watch could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Configure Availability Watch" onClose={onClose}>
      <div className="grid gap-4">
        <Field label="Remote source">
          <select
            className="h-10 rounded-md border bg-card px-3 text-sm"
            value={sourceId}
            onChange={(event) => setSourceId(Number(event.target.value))}
            disabled={readOnly || busy !== null}
          >
            <option value={0}>Any healthy source</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When available">
          <select
            className="h-10 rounded-md border bg-card px-3 text-sm"
            value={action}
            onChange={(event) => setAction(event.target.value as AvailabilityWatch["action"])}
            disabled={readOnly || busy !== null}
          >
            <option value="monitor">Monitor only</option>
            <option value="track">Track</option>
            <option value="fetch" disabled={!canManageDownloads}>
              Fetch
            </option>
            <option value="track_fetch" disabled={!canManageDownloads}>
              Track + Fetch
            </option>
          </select>
        </Field>
        <Field label="Exclude extensions">
          <input
            className="h-10 rounded-md border bg-card px-3 text-sm"
            value={excluded}
            onChange={(event) => setExcluded(event.target.value)}
            placeholder="wav, flac"
            disabled={readOnly || busy !== null}
          />
        </Field>
        {error && <ErrorPanel error={error} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => void save(false)} disabled={readOnly || busy !== null}>
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
          <Button onClick={() => void save(true)} disabled={readOnly || busy !== null}>
            {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run now
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AvailabilityWatchMonitoringDialog({
  watch,
  readOnly,
  onClose,
  onSaved,
}: {
  watch: AvailabilityWatch;
  readOnly: boolean;
  onClose: () => void;
  onSaved: (watch: AvailabilityWatch) => void;
}) {
  const toast = useToast();
  const [codes, setCodes] = useState(watch.targets.map((target) => target.workCode).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parsed = parseWorkCodes(codes);

  const save = async () => {
    if (parsed.invalid.length > 0) return;
    setSaving(true);
    setError("");
    try {
      const next = await api.updateAvailabilityWatchTargets(parsed.codes);
      onSaved(next);
      toast.success("Monitoring pool updated.");
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Monitoring pool could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit monitoring pool" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Works">
          <WorkCodesField value={codes} onChange={setCodes} ariaLabel="Works" />
        </Field>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={readOnly || saving || parsed.invalid.length > 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AvailabilityWatchReadyDialog({
  targets,
  readOnly,
  onClose,
  onChanged,
}: {
  targets: AvailabilityWatch["targets"];
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<{ id: number; action: "track" | "remove" } | null>(null);

  const openTarget = (target: AvailabilityWatch["targets"][number]) => {
    if (!target.availableSourceId) return;
    openWorkDetail(
      { kind: "remote-only", sourceId: target.availableSourceId, remoteCode: target.workCode },
      {
        returnTo: "/workflows?workflow=availability_watch&dialog=ready",
        returnLabel: "Back to Availability Watch",
      },
    );
  };
  const track = async (target: AvailabilityWatch["targets"][number]) => {
    setBusy({ id: target.id, action: "track" });
    try {
      const result = await api.trackAvailabilityWatchTarget(target.id);
      toast.success(`Track run #${result.runId} queued.`);
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, `Could not track ${target.workCode}.`));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (target: AvailabilityWatch["targets"][number]) => {
    setBusy({ id: target.id, action: "remove" });
    try {
      await api.removeAvailabilityWatchTarget(target.id);
      toast.success(`${target.workCode} removed from Availability Watch.`);
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, `Could not remove ${target.workCode}.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={`Ready works (${targets.length})`} onClose={onClose}>
      <div className="divide-y rounded-md border">
        {targets.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No available works.</div>
        ) : (
          targets.map((target) => {
            const targetBusy = busy?.id === target.id;
            return (
              <div key={target.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-semibold">{target.workCode}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant={target.lastError ? "warning" : "secondary"}>
                      {target.state === "completed" ? "dispatched" : target.state.replace("_", " ")}
                    </Badge>
                    {target.lastError && <span className="text-xs text-error-foreground">{target.lastError}</span>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openTarget(target)}
                    disabled={!target.availableSourceId || targetBusy}
                  >
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void track(target)} disabled={readOnly || targetBusy}>
                    {targetBusy && busy?.action === "track" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <GitBranchPlus className="h-4 w-4" />
                    )}
                    Track
                  </Button>
                  {(target.fetchRunId || target.trackRunId) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Open related activity"
                      aria-label={`Open activity for ${target.workCode}`}
                      onClick={() => openActivityRunID(target.fetchRunId ?? target.trackRunId!)}
                    >
                      <Activity className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Remove from watch"
                    aria-label={`Remove ${target.workCode} from watch`}
                    onClick={() => void remove(target)}
                    disabled={readOnly || targetBusy}
                  >
                    {targetBusy && busy?.action === "remove" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

function openActivityRunID(runID: number) {
  window.history.pushState({}, "", `/activity?run=${runID}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function WorkflowMetadataLoadingState() {
  return (
    <Card className="min-h-72" role="status" aria-label="Loading workflow data" aria-busy="true">
      <CardContent className="flex min-h-72 flex-col justify-center gap-3 p-6">
        <SkeletonLine className="h-5 w-40" />
        <SkeletonLine className="h-4 w-72 max-w-full" />
        <SkeletonLine className="h-32 w-full" />
      </CardContent>
    </Card>
  );
}

function WorkflowMetadataErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="min-h-72 border-destructive/30" role="alert">
      <CardContent className="grid min-h-72 place-items-center p-6 text-center">
        <div>
          <p className="text-sm text-destructive">{message}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DefinitionSidebar({
  definitions,
  triggers,
  selectedId,
  canCreate,
  activeTab,
  loading,
  error,
  emptyText,
  onSelect,
  onTabChange,
  onRetry,
  onCreate,
}: {
  definitions: WorkflowDefinition[];
  triggers: WorkflowTrigger[];
  selectedId: number | null;
  canCreate: boolean;
  activeTab: WorkflowDefinitionTab;
  loading?: boolean;
  error?: string;
  emptyText: string;
  onSelect: (definition: WorkflowDefinition) => void;
  onTabChange: (tab: WorkflowDefinitionTab) => void;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const builtInDefinitions = sortDefinitionsForSidebar(
    definitions.filter((definition) => definition.scope === "system"),
    true,
  );
  const customDefinitions = definitions
    .filter((definition) => definition.scope === "user")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div
          className="grid grid-cols-2 rounded-md border bg-muted/30 p-1"
          role="tablist"
          aria-label="Workflow definition type"
        >
          {(["built-in", "custom"] as const).map((tab) => {
            const count = tab === "built-in" ? builtInDefinitions.length : customDefinitions.length;
            return (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                className={`rounded px-2 py-1.5 text-xs font-medium ${activeTab === tab ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                onClick={() => onTabChange(tab)}
              >
                {tab === "built-in" ? "Built-in" : "Custom"} <span className="ml-1 text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="space-y-2">
          {loading ? (
            <SidebarSkeletonRows count={1} />
          ) : error ? (
            <div
              className="grid min-h-32 place-items-center rounded-md border border-destructive/30 bg-destructive/5 p-4 text-center"
              role="alert"
            >
              <div>
                <p className="text-sm text-destructive">{error}</p>
                <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            </div>
          ) : (
            <>
              {(activeTab === "built-in" ? builtInDefinitions : customDefinitions).map((definition) => (
                <DefinitionListItem
                  key={definition.id}
                  definition={definition}
                  triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === definition.id)}
                  selected={selectedId === definition.id}
                  onSelect={onSelect}
                />
              ))}
            </>
          )}
          {!loading && !error && (activeTab === "built-in" ? builtInDefinitions : customDefinitions).length === 0 && (
            <EmptyPanel text={activeTab === "custom" ? "No custom definitions yet." : emptyText} />
          )}
          {!loading && !error && canCreate && activeTab === "custom" && (
            <Button variant="outline" className="w-full" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              New workflow
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DefinitionListItem({
  definition,
  triggers,
  selected,
  onSelect,
}: {
  definition: WorkflowDefinition;
  triggers: WorkflowTrigger[];
  selected: boolean;
  onSelect: (definition: WorkflowDefinition) => void;
}) {
  const automationModes = workflowDefinitionAutomationModes(triggers);
  return (
    <button
      className={`w-full rounded-md border p-3 text-left transition-colors ${selected ? "border-primary bg-secondary" : "bg-card hover:bg-muted"}`}
      onClick={() => onSelect(definition)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-semibold">{definition.displayName}</div>
          <div className="truncate text-xs text-muted-foreground">{definition.code}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{workflowDefinitionNodeCount(definition.definitionJson)} nodes</span>
          <span>
            {definition.triggerCount} trigger{definition.triggerCount === 1 ? "" : "s"}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {automationModes.map((mode) => (
            <Badge key={mode} variant={mode === "manual" ? "outline" : "secondary"} className="capitalize">
              {mode}
            </Badge>
          ))}
        </div>
      </div>
    </button>
  );
}

function ActivityToolbar({
  query,
  onQueryChange,
  onSearch,
  onRecoverStale,
  readOnly,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onRecoverStale: () => Promise<void>;
  readOnly: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-b pb-3 md:flex-row md:items-center md:justify-between">
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
        <Button size="sm" variant="outline" onClick={() => void onRecoverStale()} disabled={readOnly}>
          <RotateCcw className="h-3.5 w-3.5" />
          Recover stale
        </Button>
      </div>
    </div>
  );
}

function ActivityLoadingState() {
  return (
    <div
      className="flex min-h-32 items-center rounded-lg border bg-card p-4"
      role="status"
      aria-label="Loading runs"
      aria-busy="true"
    >
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonLine className="h-4 w-3/4 max-w-48" />
          <SkeletonLine className="h-3 w-72 max-w-full" />
        </div>
      </div>
    </div>
  );
}

function ActivityPendingState() {
  return <div className="min-h-32" aria-busy="true" />;
}

function ActivityErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="grid min-h-32 place-items-center rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center"
      role="alert"
    >
      <div>
        <p className="text-sm text-destructive">{message}</p>
        <Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function ActivityEmptyState({ view, filtered }: { view: ActivityView; filtered: boolean }) {
  const messages: Record<ActivityView, string> = {
    running: "No workflows are running.",
    review: "No runs need review.",
    failed: "No workflow runs have failed.",
    completed: "No completed workflow runs yet.",
  };
  return (
    <div className="grid min-h-32 place-items-center rounded-lg border border-dashed bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
      {filtered ? "No runs match this search." : messages[view]}
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
          <div className="flex items-start gap-2">
            {loading && (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-primary" aria-label="Refreshing runs" />
            )}
            <div>
              <div className="font-semibold">Runs</div>
              <div className="text-xs text-muted-foreground">
                {start}-{end} of {total}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              disabled={page <= 1}
              onClick={onPrevious}
              aria-label="Previous runs page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8"
              disabled={page >= totalPages}
              onClick={onNext}
              aria-label="Next runs page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="divide-y rounded-md border">
          {loading && runs.length === 0 ? (
            <RunSidebarSkeletonRows />
          ) : (
            runs.map((run) => (
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
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <StatusBadge status={run.status} />
                    {run.reviewedAt && <Badge variant="secondary">Reviewed</Badge>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{formatRunTime(run)}</span>
                  <span>
                    {run.completedNodeRuns}/{run.nodeRunCount} nodes
                  </span>
                  {run.failedNodeRuns > 0 && <span className="text-error-foreground">{run.failedNodeRuns} failed</span>}
                  {run.skippedNodeRuns > 0 && <span>{run.skippedNodeRuns} skipped</span>}
                  {pendingReviewCount(run) > 0 && (
                    <span className="text-primary">{pendingReviewCount(run)} review</span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
        {!loading && runs.length === 0 && <EmptyPanel text="No runs in this view." />}
        <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
          <span>
            Page {page} / {totalPages}
          </span>
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
    <div className="p-3">
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
  );
}

function WorkflowDetail({
  definition,
  definitionTriggers = [],
  nodeTypes,
  readonly,
  canManageTriggers,
  systemRunKinds,
  isSystemActionRunning,
  canRunSystemAction,
  onRunSystemAction,
  onRunRemotePopular,
  canFetchRemotePopular = false,
  onRunDLsitePopular,
  recentRuns = [],
  onOpenRun,
  onRunDefinition,
  emptyText = "Select a workflow to inspect its node pipeline.",
  onEditDefinition,
  onCreateTrigger,
  onEditTrigger,
  onToggleTrigger,
  onEditNode,
}: {
  definition: WorkflowDefinition | null;
  definitionTriggers?: WorkflowTrigger[];
  nodeTypes: WorkflowNodeType[];
  readonly: boolean;
  canManageTriggers: boolean;
  systemRunKinds?: SystemRunKind[];
  isSystemActionRunning?: (kind: SystemRunKind) => boolean;
  canRunSystemAction?: (kind: SystemRunKind) => boolean;
  onRunSystemAction?: (kind: SystemRunKind, options?: SystemRunOptions) => Promise<void>;
  onRunRemotePopular?: (options: RemotePopularRunOptions) => Promise<void>;
  canFetchRemotePopular?: boolean;
  onRunDLsitePopular?: (options: DLsitePopularRunOptions) => Promise<void>;
  recentRuns?: WorkflowRun[];
  onOpenRun?: (run: WorkflowRun) => void;
  onRunDefinition?: (inputs?: Record<string, unknown>, autoPreview?: boolean) => void;
  emptyText?: string;
  onEditDefinition?: () => void;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType) => void;
  onEditTrigger: (trigger: WorkflowTrigger) => void;
  onToggleTrigger: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
  onEditNode: (index: number) => void;
}) {
  const [configuredSystemRun, setConfiguredSystemRun] = useState<
    "local_scan" | "dlsite_popular" | "remote_popular" | null
  >(null);
  const [quickRunValues, setQuickRunValues] = useState<Record<string, string>>({});
  const definitionID = definition?.id ?? null;
  const definitionJson = definition?.definitionJson ?? "";

  useEffect(() => {
    setConfiguredSystemRun(null);
    const parsed = definitionJson ? parseWorkflowDefinition(definitionJson) : null;
    setQuickRunValues(
      parsed?.kind === "v2"
        ? Object.fromEntries(parsed.document.inputs.map((input) => [input.key, input.defaultValue ?? ""]))
        : {},
    );
  }, [definitionID, definitionJson]);

  if (!definition) {
    return <EmptyPanel text={emptyText} />;
  }
  const parsedDefinition = parseWorkflowDefinition(definition.definitionJson);
  const nodes = parsedDefinition.kind === "v2" ? parsedDefinition.document.nodes : parsedDefinition.nodes;
  const workflowInputs = parsedDefinition.kind === "v2" ? parsedDefinition.document.inputs : [];
  const quickRunInput =
    workflowInputs.length === 1 && workflowInputs[0].type !== "work_codes" ? workflowInputs[0] : null;
  const legacyUpgrade =
    parsedDefinition.kind === "legacy"
      ? upgradeLegacyWorkflowDefinition(parsedDefinition.nodes, definitionTriggers)
      : null;
  const composerEditable = parsedDefinition.kind === "v2";
  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 space-y-5 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{definition.displayName}</h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{definition.description || "No description."}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{definition.code}</span>
              <span>{nodes.length} nodes</span>
              <span>
                {definition.triggerCount} trigger{definition.triggerCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {composerEditable && onEditDefinition && (
              <Button size="sm" onClick={onEditDefinition}>
                <Edit3 className="h-4 w-4" />
                Edit workflow
              </Button>
            )}
            {!readonly && parsedDefinition.kind === "legacy" && (
              <Button
                size="sm"
                variant="outline"
                disabled
                title="Legacy workflow upgrade is reserved for a future release."
              >
                <FileJson className="h-4 w-4" />
                Upgrade workflow
              </Button>
            )}
            {onRunDefinition && parsedDefinition.kind === "v2" && !quickRunInput && (
              <Button size="sm" onClick={() => onRunDefinition()}>
                <Play className="h-4 w-4" />
                {workflowInputs.length > 0 ? "Configure" : "Preview / Run"}
              </Button>
            )}
            {definition.scope === "system" &&
              systemRunKinds &&
              onRunSystemAction &&
              systemRunKinds
                .filter((kind) => kind === "metadata_sync")
                .map((kind) => {
                  const running = isSystemActionRunning?.(kind) ?? false;
                  const allowed = canRunSystemAction?.(kind) ?? false;
                  return (
                    <Button
                      key={kind}
                      size="sm"
                      onClick={() => void onRunSystemAction(kind)}
                      disabled={running || !allowed}
                    >
                      <Play className="h-4 w-4" />
                      {running ? "Creating" : systemRunKindLabel(kind)}
                    </Button>
                  );
                })}
            {definition.scope === "system" &&
              systemRunKinds
                ?.filter(
                  (kind): kind is "local_scan" | "dlsite_popular" | "remote_popular" =>
                    kind === "local_scan" || kind === "dlsite_popular" || kind === "remote_popular",
                )
                .map((kind) => {
                  const running = isSystemActionRunning?.(kind) ?? false;
                  const allowed = canRunSystemAction?.(kind) ?? false;
                  return (
                    <Button
                      key={kind}
                      size="sm"
                      onClick={() => setConfiguredSystemRun(kind)}
                      disabled={running || !allowed}
                    >
                      <Settings2 className="h-4 w-4" />
                      {running ? "Queueing" : "Configure"}
                    </Button>
                  );
                })}
          </div>
        </div>

        {onRunDefinition && quickRunInput && (
          <CustomWorkflowQuickRun
            input={quickRunInput}
            value={quickRunValues[quickRunInput.key] ?? ""}
            onChange={(value) => setQuickRunValues((current) => ({ ...current, [quickRunInput.key]: value }))}
            onPreview={() => onRunDefinition({ [quickRunInput.key]: quickRunValues[quickRunInput.key] ?? "" }, true)}
          />
        )}

        <WorkflowAutomationPanel
          definition={definition}
          triggers={definitionTriggers}
          canManage={canManageTriggers}
          onCreate={onCreateTrigger}
          onEdit={onEditTrigger}
          onToggle={onToggleTrigger}
        />

        {definition.scope === "system" && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {systemRunKinds?.length
              ? "This system workflow is read-only, but it exposes a manual action."
              : "This system workflow is read-only and is triggered by application actions."}
          </div>
        )}
        {definition.scope === "user" && parsedDefinition.kind === "legacy" && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Legacy upgrade is reserved for a future release. This definition remains read-only, and its original linear
            connections are shown below.
            {legacyUpgrade?.kind === "blocked" && (
              <span className="ml-1">Compatibility check: {legacyUpgrade.reasons.join(" ")}</span>
            )}
          </div>
        )}
        {parsedDefinition.kind === "v2" ? (
          <WorkflowCanvas
            document={parsedDefinition.document}
            nodeTypes={nodeTypes}
            selectedNodeId=""
            readonly
            compact
            onChange={() => undefined}
            onSelectNode={() => undefined}
          />
        ) : (
          <DefinitionNodeCanvas nodes={nodes} nodeTypes={nodeTypes} readonly onEditNode={onEditNode} />
        )}
        {onOpenRun && <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />}
        {parsedDefinition.kind === "legacy" && <WorkflowHints nodes={nodes} nodeTypes={nodeTypes} compact />}
      </CardContent>
      {configuredSystemRun === "local_scan" && onRunSystemAction && (
        <Modal title="Configure local library scan" onClose={() => setConfiguredSystemRun(null)}>
          <LocalScanRunPanel
            running={isSystemActionRunning?.("local_scan") ?? false}
            allowed={canRunSystemAction?.("local_scan") ?? false}
            onRun={(followUpRun) => onRunSystemAction("local_scan", { followUpRun })}
          />
        </Modal>
      )}
      {configuredSystemRun === "dlsite_popular" && onRunDLsitePopular && (
        <Modal title="Configure DLsite popular collection" onClose={() => setConfiguredSystemRun(null)}>
          <DLsitePopularRunPanel
            running={isSystemActionRunning?.("dlsite_popular") ?? false}
            allowed={canRunSystemAction?.("dlsite_popular") ?? false}
            onRun={onRunDLsitePopular}
          />
        </Modal>
      )}
      {configuredSystemRun === "remote_popular" && onRunRemotePopular && (
        <Modal title="Configure remote popular collection" onClose={() => setConfiguredSystemRun(null)}>
          <RemotePopularRunPanel
            running={isSystemActionRunning?.("remote_popular") ?? false}
            allowed={canRunSystemAction?.("remote_popular") ?? false}
            canFetch={canFetchRemotePopular}
            onRun={onRunRemotePopular}
          />
        </Modal>
      )}
    </Card>
  );
}

function LocalScanRunPanel({
  running,
  allowed,
  onRun,
}: {
  running: boolean;
  allowed: boolean;
  onRun: (followUpRun: boolean) => Promise<void>;
}) {
  const [followUpRun, setFollowUpRun] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-3">
        <div>
          <div className="text-sm font-medium">Follow-up run</div>
          <div className="text-xs text-muted-foreground">
            Queue an independent metadata sync after this local scan completes.
          </div>
        </div>
        <Switch
          checked={followUpRun}
          onCheckedChange={setFollowUpRun}
          aria-label="Follow-up run"
          disabled={running || !allowed}
        />
      </div>
      <Button className="w-full" disabled={running || !allowed} onClick={() => void onRun(followUpRun)}>
        <Play className="h-4 w-4" />
        {running ? "Creating" : "Run scan"}
      </Button>
    </div>
  );
}

function CustomWorkflowQuickRun({
  input,
  value,
  onChange,
  onPreview,
}: {
  input: WorkflowInputDefinition;
  value: string;
  onChange: (value: string) => void;
  onPreview: () => void;
}) {
  const missingRequiredValue = input.required && !value.trim();
  return (
    <form
      className="flex flex-col gap-2 rounded-md border bg-muted/25 p-3 sm:flex-row sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (!missingRequiredValue) onPreview();
      }}
      aria-label="Quick run inputs"
    >
      <label className="grid min-w-0 flex-1 gap-1.5 text-sm">
        <span className="font-medium">
          {input.label}
          {input.required && <span className="text-error-foreground"> *</span>}
        </span>
        <input
          className="h-9 w-full rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={workflowInputPlaceholder(input)}
          autoCapitalize="off"
          spellCheck={input.type === "text" || input.type === "voice_name"}
        />
      </label>
      <Button type="submit" size="sm" className="h-9 shrink-0" disabled={missingRequiredValue}>
        <Play className="h-4 w-4" />
        Preview
      </Button>
    </form>
  );
}

function workflowInputPlaceholder(input: WorkflowInputDefinition) {
  switch (input.type) {
    case "circle_id":
      return "RG012345";
    case "series_id":
      return "SRI0000000000";
    case "work_code":
      return "RJ00000000";
    case "voice_name":
      return "Voice name";
    default:
      return input.label;
  }
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
  const [tagNameTemplate, setTagNameTemplate] = useState(REMOTE_POPULAR_TAG_TEMPLATE);
  const [loadingSources, setLoadingSources] = useState(true);
  const compatibleSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );
  const selectedSource = compatibleSources.find((source) => source.id === sourceId) ?? null;
  const tagTokens = remotePopularTagTemplateTokens(selectedSource, action, new Date());
  const tagPreview = workflowTagTemplatePreview(tagNameTemplate, workflowTagTemplateTokenValues(tagTokens));
  const tagError = workflowTagTemplateBlockers(
    tagNameTemplate,
    tagTokens.map((token) => token.name),
  )[0];

  useEffect(() => {
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const first = items.find(
          (source) =>
            source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
        );
        setSourceId((current) => current || first?.id || 0);
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const canSubmit =
    allowed && sourceId > 0 && !tagError && tagPreview.value.length > 0 && (action !== "fetch" || canFetch);
  return (
    <section>
      <div className="grid gap-4">
        <div className="space-y-4">
          <label className="grid gap-2 text-sm font-medium">
            Remote source
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={sourceId}
              disabled={loadingSources || compatibleSources.length === 0}
              onChange={(event) => setSourceId(Number(event.target.value))}
            >
              {compatibleSources.length === 0 && (
                <option value={0}>{loadingSources ? "Loading sources" : "No compatible source"}</option>
              )}
              {compatibleSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
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
              {action === "fetch" && !canFetch && (
                <div className="mt-1 text-xs text-error-foreground">Fetch requires download management permission.</div>
              )}
            </div>
            <label className="grid content-start gap-2 text-sm font-medium">
              Work limit
              <select
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              >
                {[10, 25, 50, 100].map((item) => (
                  <option key={item} value={item}>
                    {item} works
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="grid min-w-0 gap-4 pt-1">
          <TagTemplateField
            id="remote-popular-tag-template"
            value={tagNameTemplate}
            defaultValue={REMOTE_POPULAR_TAG_TEMPLATE}
            tokens={tagTokens}
            preview={tagPreview}
            error={tagError}
            spanColumns={false}
            onChange={setTagNameTemplate}
          />
          <Button
            className="w-full"
            disabled={running || !canSubmit}
            onClick={() => void onRun({ sourceId, action, limit, tagNameTemplate: tagNameTemplate.trim() })}
          >
            <Play className="h-4 w-4" />
            {running ? "Queueing" : "Run collection"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function DLsitePopularRunPanel({
  running,
  allowed,
  onRun,
}: {
  running: boolean;
  allowed: boolean;
  onRun: (options: DLsitePopularRunOptions) => Promise<void>;
}) {
  const [period, setPeriod] = useState<DLsitePopularPeriod>("day");
  const [recentOnly, setRecentOnly] = useState(true);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const releaseWindow: "30d" | "" = period === "year" ? "" : recentOnly ? "30d" : "";
  const defaultTagTemplate = dlsitePopularDefaultTagTemplate(period);
  const [tagNameTemplate, setTagNameTemplate] = useState(defaultTagTemplate);
  const [tagCustomized, setTagCustomized] = useState(false);
  const tagTokens = dlsitePopularTagTemplateTokens(period, releaseWindow, year, new Date());
  const tagPreview = workflowTagTemplatePreview(tagNameTemplate, workflowTagTemplateTokenValues(tagTokens));
  const tagError = workflowTagTemplateBlockers(
    tagNameTemplate,
    tagTokens.map((token) => token.name),
  )[0];
  const years = Array.from({ length: currentYear - 1999 }, (_, index) => currentYear - index);
  const periodOptions: { value: DLsitePopularPeriod; label: string }[] = [
    { value: "day", label: "24h" },
    { value: "week", label: "7d" },
    { value: "month", label: "30d" },
    { value: "year", label: "Year" },
  ];

  useEffect(() => {
    if (!tagCustomized) setTagNameTemplate(defaultTagTemplate);
  }, [defaultTagTemplate, tagCustomized]);

  return (
    <section>
      <div className="grid gap-4">
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium">Ranking period</div>
            <div
              className="mt-2 inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1"
              aria-label="DLsite ranking period"
            >
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
              <select
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
              >
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                    {item === currentYear ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">Recent releases only</div>
                <div className="text-xs text-muted-foreground">Limit the ranking to works released within 30 days.</div>
              </div>
              <Switch
                checked={recentOnly}
                onCheckedChange={setRecentOnly}
                aria-label="Only works released within 30 days"
              />
            </div>
          )}
        </div>

        <div className="grid min-w-0 gap-4 pt-1">
          <TagTemplateField
            id="dlsite-popular-tag-template"
            value={tagNameTemplate}
            defaultValue={defaultTagTemplate}
            tokens={tagTokens}
            preview={tagPreview}
            error={tagError}
            spanColumns={false}
            onChange={(next) => {
              setTagCustomized(next !== defaultTagTemplate);
              setTagNameTemplate(next);
            }}
          />
          <Button
            className="w-full"
            disabled={running || !allowed || Boolean(tagError) || !tagPreview.value}
            onClick={() =>
              void onRun({
                period,
                releaseWindow,
                year: period === "year" ? year : 0,
                tagNameTemplate: tagNameTemplate.trim(),
              })
            }
          >
            <Play className="h-4 w-4" />
            {running ? "Queueing" : "Run collection"}
          </Button>
        </div>
      </div>
    </section>
  );
}

function useRecentWorkflowNodeStarts(runID: number | null, status: string, events: WorkflowEvent[]) {
  const [recentNodeRunIDs, setRecentNodeRunIDs] = useState<Set<number>>(() => new Set());
  const trackedRunID = useRef<number | null>(null);
  const lastEventID = useRef(0);
  const wasActive = useRef(false);
  const timers = useRef(new Map<number, number>());

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  useEffect(() => {
    const active = status === "queued" || status === "running";
    if (trackedRunID.current !== runID) {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
      trackedRunID.current = runID;
      lastEventID.current = events.reduce((maximum, event) => Math.max(maximum, event.id), 0);
      wasActive.current = active;
      setRecentNodeRunIDs(new Set());
      return;
    }

    const newEvents = events.filter((event) => event.id > lastEventID.current);
    lastEventID.current = events.reduce((maximum, event) => Math.max(maximum, event.id), lastEventID.current);
    const shouldPulse = active || wasActive.current;
    wasActive.current = active;
    if (!shouldPulse) return;

    const startedNodeRunIDs = newEvents.flatMap((event) =>
      event.eventType === "custom_workflow.node_started" && event.nodeRunId ? [event.nodeRunId] : [],
    );
    if (startedNodeRunIDs.length === 0) return;
    setRecentNodeRunIDs((current) => new Set([...current, ...startedNodeRunIDs]));
    startedNodeRunIDs.forEach((nodeRunID) => {
      const existing = timers.current.get(nodeRunID);
      if (existing !== undefined) window.clearTimeout(existing);
      timers.current.set(
        nodeRunID,
        window.setTimeout(() => {
          timers.current.delete(nodeRunID);
          setRecentNodeRunIDs((current) => {
            const next = new Set(current);
            next.delete(nodeRunID);
            return next;
          });
        }, 1800),
      );
    });
  }, [events, runID, status]);

  return recentNodeRunIDs;
}

function parseWorkflowRunGraph(value: string | undefined): WorkflowRunGraph | null {
  if (!value?.trim()) return null;
  try {
    const graph = JSON.parse(value) as WorkflowRunGraph;
    if (
      graph.schemaVersion !== 1 ||
      !Array.isArray(graph.nodes) ||
      graph.nodes.length === 0 ||
      !Array.isArray(graph.edges)
    )
      return null;
    return graph;
  } catch {
    return null;
  }
}

function RunDetail({
  run,
  events,
  candidates,
  nodeTypes,
  loading = false,
  onCandidateUpdate,
  onRunAction,
  readOnly,
}: {
  run: WorkflowRunDetail | WorkflowRun | null;
  events: WorkflowEvent[];
  candidates: WorkflowCandidate[];
  nodeTypes: WorkflowNodeType[];
  loading?: boolean;
  onCandidateUpdate: () => Promise<void>;
  onRunAction: () => Promise<void>;
  readOnly: boolean;
}) {
  const recentlyStartedNodeRuns = useRecentWorkflowNodeStarts(run?.id ?? null, run?.status ?? "", events);
  if (!run) {
    return loading ? <RunDetailSkeleton /> : <EmptyPanel text="Select a run to inspect execution by node." />;
  }
  const nodeRuns = "nodeRuns" in run ? run.nodeRuns : [];
  const runGraph = "graphJson" in run ? parseWorkflowRunGraph(run.graphJson) : null;
  const nodeRunByNodeID = new Map(nodeRuns.map((node) => [node.nodeId, node]));
  const canvasNodes: WorkflowCanvasItem[] = runGraph
    ? runGraph.nodes.map((node) => {
        const nodeRun = nodeRunByNodeID.get(node.id);
        return {
          id: node.id,
          title: node.displayName || nodeRun?.displayName || node.id,
          subtitle: nodeSubtitle(node.type, nodeTypes),
          status: nodeRun?.status ?? "queued",
          detail: nodeRun?.errorMessage || summarizeJSON(nodeRun?.outputJson ?? "") || node.type,
          position: node.position,
          flowing: Boolean(nodeRun && recentlyStartedNodeRuns.has(nodeRun.id)),
        };
      })
    : nodeRuns.map((node) => ({
        id: String(node.id),
        title: node.displayName || node.nodeId,
        subtitle: nodeSubtitle(node.nodeType, nodeTypes),
        status: node.status,
        detail: node.errorMessage || summarizeJSON(node.outputJson) || node.nodeType,
        flowing: recentlyStartedNodeRuns.has(node.id),
      }));
  const canvasConnections: WorkflowCanvasConnection[] | undefined = runGraph?.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    dataType: edge.dataType,
  }));
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
            {!readOnly && <RunActions run={run} onRunAction={onRunAction} />}
          </div>
        </div>
        {loading ? <RunOverviewSkeleton /> : <RunOverview run={run} nodeRuns={nodeRuns} />}
        <section className="space-y-2">
          <div className="text-sm font-semibold">Execution</div>
          {loading ? (
            <RunNodePipelineSkeleton />
          ) : nodeRuns.length > 0 ? (
            <WorkflowNodeCanvas
              compact
              nodes={canvasNodes}
              connections={canvasConnections}
              onNodeClick={(nodeID) => {
                const nodeRunID = runGraph ? nodeRunByNodeID.get(nodeID)?.id : Number(nodeID);
                if (nodeRunID)
                  document
                    .getElementById(`workflow-node-${nodeRunID}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          ) : (
            <EmptyPanel text="This run has no node detail yet." />
          )}
        </section>
        {loading ? (
          <RunItemsSkeleton />
        ) : (
          <RunItems run={run} candidates={candidates} onCandidateUpdate={onCandidateUpdate} readOnly={readOnly} />
        )}
        {loading ? <RunLogsSkeleton /> : <ActivityNodeSections run={run} nodes={nodeRuns} events={events} />}
      </CardContent>
    </Card>
  );
}

function RunDetailSkeleton() {
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
        <RunOverviewSkeleton />
        <RunNodePipelineSkeleton />
        <RunItemsSkeleton />
        <RunLogsSkeleton />
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
          {Array.from({ length: 4 }, (_, index) => (
            <SkeletonLine key={index} className="h-3 w-full" />
          ))}
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

function RunOverview({ run, nodeRuns }: { run: WorkflowRunDetail | WorkflowRun; nodeRuns: WorkflowNodeRun[] }) {
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <FetchTransferProgress run={run} />
      <div className="min-w-0 rounded-md border bg-muted/30 p-3">
        <div className="text-sm font-semibold">Summary</div>
        <JsonPreview value={run.summaryJson} empty="No summary recorded." />
      </div>
      <div className="grid content-start gap-2">
        <SummaryCell label="Started" value={run.startedAt || "not recorded"} />
        <SummaryCell label="Finished" value={run.finishedAt || "not finished"} />
        <SummaryCell
          label="Trigger"
          value={`${run.triggerType}${run.triggerReason ? ` · ${run.triggerReason}` : ""}`}
        />
        <SummaryCell
          label="Run signals"
          value={`${pendingReviewCount(run)} pending review, ${run.skippedNodeRuns + run.skippedJobs} skipped`}
        />
      </div>
      {nodeRuns.some((node) => node.errorMessage) && (
        <div className="lg:col-span-2">
          <ErrorPanel error={nodeRuns.find((node) => node.errorMessage)?.errorMessage ?? ""} />
        </div>
      )}
    </div>
  );
}

function FetchTransferProgress({ run }: { run: WorkflowRunDetail | WorkflowRun }) {
  if (run.workflowCode !== "remote_work_fetch") return null;
  const current = Math.max(0, run.progressBytesCurrent ?? 0);
  const total = Math.max(0, run.progressBytesTotal ?? 0);
  const unknownItems = Math.max(0, run.progressBytesUnknownItems ?? 0);
  if (current === 0 && total === 0 && unknownItems === 0 && !["queued", "running"].includes(run.status)) return null;
  const determinate = unknownItems === 0 && total > 0;
  const percent = determinate ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
  const label =
    unknownItems > 0
      ? `${formatBytes(current)} transferred · ${formatBytes(total)} known total · ${unknownItems} unknown-size ${unknownItems === 1 ? "file" : "files"}`
      : total > 0
        ? `${formatBytes(current)} of ${formatBytes(total)}`
        : `${formatBytes(current)} transferred`;
  return (
    <div
      className="space-y-2 rounded-md border bg-muted/30 p-3 lg:col-span-2"
      role="status"
      aria-label="Fetch transfer progress"
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-semibold">Transfer</span>
        <span className="tabular-nums text-muted-foreground">{label}</span>
      </div>
      {determinate ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Fetch byte progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={Math.min(current, total)}
          aria-valuetext={label}
        >
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      ) : (
        <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/70" />
        </div>
      )}
    </div>
  );
}

function RunItems({
  run,
  candidates,
  onCandidateUpdate,
  readOnly,
}: {
  run: WorkflowRunDetail | WorkflowRun;
  candidates: WorkflowCandidate[];
  onCandidateUpdate: () => Promise<void>;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-semibold">Items</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Metric
          icon={<FileJson className="h-3.5 w-3.5" />}
          label="pending review"
          value={`${pendingReviewCount(run)}`}
        />
        <Metric
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          label="failed items"
          value={`${run.failedNodeRuns + run.failedJobs}`}
        />
        <Metric
          icon={<Clock3 className="h-3.5 w-3.5" />}
          label="skipped items"
          value={`${run.skippedNodeRuns + run.skippedJobs}`}
        />
      </div>
      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Candidates</div>
          <div className="divide-y rounded-md border">
            {candidates.map((candidate) => (
              <CandidateReviewCard
                key={candidate.id}
                candidate={candidate}
                onCandidateUpdate={onCandidateUpdate}
                readOnly={readOnly}
              />
            ))}
          </div>
        </div>
      )}
      {candidates.length === 0 && (
        <div className="rounded-md border p-3 text-sm text-muted-foreground">
          No reviewable items recorded for this run.
        </div>
      )}
    </div>
  );
}

function ActivityNodeSections({
  run,
  nodes,
  events,
}: {
  run: WorkflowRunDetail | WorkflowRun;
  nodes: WorkflowNodeRun[];
  events: WorkflowEvent[];
}) {
  const [openNodes, setOpenNodes] = useState<Set<number>>(
    () =>
      new Set(nodes.filter((node) => ["running", "failed", "partial"].includes(node.status)).map((node) => node.id)),
  );
  useEffect(() => {
    setOpenNodes((current) => {
      const next = new Set(current);
      nodes
        .filter((node) => ["running", "failed", "partial"].includes(node.status))
        .forEach((node) => next.add(node.id));
      return next;
    });
  }, [nodes]);
  const runEvents = events.filter((event) => event.nodeRunId === null);
  return (
    <section className="space-y-3">
      <div className="text-sm font-semibold">Node logs</div>
      <div className="divide-y rounded-md border">
        {nodes.map((node) => {
          const open = openNodes.has(node.id);
          const nodeEvents = events.filter((event) => event.nodeRunId === node.id);
          return (
            <section key={node.id} id={`workflow-node-${node.id}`} className="scroll-mt-24">
              <button
                className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40"
                aria-expanded={open}
                onClick={() =>
                  setOpenNodes((current) => {
                    const next = new Set(current);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    return next;
                  })
                }
              >
                <ChevronRight className={`h-4 w-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                <StatusPoint status={node.status} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{node.displayName || node.nodeId}</span>
                <span className="text-xs text-muted-foreground">{nodeEvents.length} events</span>
                <StatusBadge status={node.status} />
              </button>
              {open && (
                <div className="space-y-3 border-t bg-muted/15 px-3 py-3">
                  {node.errorMessage && <ErrorPanel error={node.errorMessage} />}
                  {hasNonEmptyJSON(node.outputJson) && (
                    <JsonPreview value={node.outputJson} empty="No output payload." compact />
                  )}
                  <WorkflowEventRows events={nodeEvents} empty="No events recorded for this node." />
                </div>
              )}
            </section>
          );
        })}
      </div>
      {runEvents.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold">Run events</div>
          <div className="rounded-md border">
            <WorkflowEventRows events={runEvents} empty="No run events." />
          </div>
        </div>
      )}
      {nodes.length === 0 && <RunLogs run={run} nodeRuns={nodes} events={events} />}
    </section>
  );
}

function WorkflowEventRows({ events, empty }: { events: WorkflowEvent[]; empty: string }) {
  if (events.length === 0) return <div className="p-3 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="divide-y rounded-md border bg-background">
      {events.map((event) => (
        <div key={event.id} className="grid gap-1 p-3 text-sm md:grid-cols-[150px_70px_minmax(0,1fr)]">
          <div className="text-xs text-muted-foreground">{event.createdAt}</div>
          <div
            className={
              event.level === "error"
                ? "text-error-foreground"
                : event.level === "warn"
                  ? "text-warning-foreground"
                  : "text-muted-foreground"
            }
          >
            {event.level}
          </div>
          <div className="min-w-0">
            <div className="font-medium">{event.message}</div>
            <div className="text-xs text-muted-foreground">{event.eventType}</div>
            {hasNonEmptyJSON(event.detailJson) && (
              <div className="mt-1 break-words text-xs text-muted-foreground">{summarizeJSON(event.detailJson)}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CandidateReviewCard({
  candidate,
  onCandidateUpdate,
  readOnly,
}: {
  candidate: WorkflowCandidate;
  onCandidateUpdate: () => Promise<void>;
  readOnly: boolean;
}) {
  const [confirmDeleteOldFiles, setConfirmDeleteOldFiles] = useState(false);
  const [archiveDeleteStep, setArchiveDeleteStep] = useState<0 | 1 | 2>(0);
  const payload = parseJSONRecord(candidate.payloadJson);
  const cleanupLocations = candidate.type === "local_fetch_merge_cleanup" ? localCleanupLocations(payload) : [];
  const archivedRoots = candidate.type === "local_fetch_merge_cleanup" ? localArchivedRoots(payload) : [];
  const duplicateFolders = candidate.type === "local_duplicate_work_folder" ? localDuplicateFolders(payload) : [];
  const originBlocked = candidate.type === "remote_origin_blocked";
  const blockedOrigin = originBlocked ? stringValue(payload.origin) : "";
  const blockedSourceID = originBlocked ? numberValue(payload.source_id) : null;
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
          <div className="text-xs text-muted-foreground">
            {candidate.type} · updated {candidate.updatedAt}
          </div>
        </div>
        <StatusBadge status={candidate.status} />
      </div>

      {candidate.type === "local_fetch_merge_cleanup" && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">
            {archivedRoots.length > 0 ? "Archived local roots" : "Old local locations"}
          </div>
          {archivedRoots.map((root) => (
            <div key={root.folderId} className="space-y-1 border-b py-2 last:border-b-0">
              <div className="font-medium">{root.originalPath}</div>
              <div className="truncate text-muted-foreground" title={root.archivePath}>
                {root.archivePath}
              </div>
              <div className="text-muted-foreground">
                {root.fileCount} files · {formatBytes(root.sizeBytes)}
              </div>
              {root.files.slice(0, 12).map((file) => (
                <div key={file.path} className="flex gap-2 pl-2">
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                </div>
              ))}
              {root.files.length > 12 && (
                <div className="pl-2 text-muted-foreground">+{root.files.length - 12} more</div>
              )}
            </div>
          ))}
          {archivedRoots.length === 0 && cleanupLocations.length > 0
            ? cleanupLocations.slice(0, 8).map((location) => (
                <div key={location.locationId} className="flex gap-2 py-0.5">
                  <span className="w-12 shrink-0 text-muted-foreground">#{location.locationId}</span>
                  <span className="min-w-0 flex-1 truncate">{location.path}</span>
                  {location.sizeBytes !== null && (
                    <span className="shrink-0 text-muted-foreground">{formatBytes(location.sizeBytes)}</span>
                  )}
                </div>
              ))
            : archivedRoots.length === 0 && (
                <div className="text-muted-foreground">No selectable local locations in this candidate.</div>
              )}
          {archivedRoots.length === 0 && cleanupLocations.length > 8 && (
            <div className="pt-1 text-muted-foreground">+{cleanupLocations.length - 8} more</div>
          )}
        </div>
      )}

      {candidate.type === "local_duplicate_work_folder" && (
        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">Duplicate local folders</div>
          {duplicateFolders.map((folder) => (
            <div key={folder.relPath} className="grid gap-0.5 py-1">
              <div className="truncate">{folder.relPath}</div>
              <div className="text-muted-foreground">
                {folder.files} files · {folder.audioFiles} audio · {formatBytes(folder.sizeBytes)}
              </div>
            </div>
          ))}
        </div>
      )}

      {originBlocked && (
        <div className="min-w-0 rounded-md border border-warning-border bg-warning-surface p-3 text-sm">
          <div className="font-medium text-warning-foreground">Outbound origin blocked</div>
          <div className="mt-1 break-all font-mono text-xs text-warning-foreground">
            {blockedOrigin || "Origin was not recorded"}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            This source restricts outbound hosts. Add the hostname to the source allowlist, or change the source policy,
            then retry this Fetch.
          </p>
        </div>
      )}

      {candidate.type !== "local_fetch_merge_cleanup" &&
        candidate.type !== "local_duplicate_work_folder" &&
        !originBlocked && <JsonPreview value={candidate.payloadJson} empty="No candidate payload." compact />}
      {hasNonEmptyJSON(candidate.decisionJson) && (
        <JsonPreview value={candidate.decisionJson} empty="No decision payload." compact />
      )}
      {needsReview && !readOnly && (
        <div className="flex flex-wrap gap-2">
          {originBlocked && (
            <>
              {blockedSourceID !== null && blockedSourceID > 0 && (
                <Button size="sm" variant="outline" onClick={() => openRemoteSourceConfiguration(blockedSourceID)}>
                  <Settings2 className="h-4 w-4" />
                  Configure source
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await api.retryWorkflowRun(candidate.runId);
                  await onCandidateUpdate();
                }}
              >
                <RotateCcw className="h-4 w-4" />
                Retry Fetch
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && cleanupLocations.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void cleanup("mark_unavailable")}>
                Hide old locations
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                onClick={() => setConfirmDeleteOldFiles(true)}
              >
                Delete old files
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && archivedRoots.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void reviewArchive("keep_archived")}>
                Keep archived
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                onClick={() => setArchiveDeleteStep(1)}
              >
                Delete archive
              </Button>
            </>
          )}
          {archivedRoots.length === 0 && !originBlocked && (
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
          <div className="mt-1 text-sm text-muted-foreground">
            This deletes the selected old files from disk and marks their locations unavailable. Work metadata is kept.
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmDeleteOldFiles(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void cleanup("delete_files")}
            >
              Delete files
            </Button>
          </div>
        </div>
      )}
      {archiveDeleteStep > 0 && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3">
          <div className="text-sm font-semibold text-destructive">
            {archiveDeleteStep === 1 ? "Review archived directories" : "Final confirmation"}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {archiveDeleteStep === 1
              ? "These archived roots will be permanently removed from disk."
              : "This cannot be undone. Work metadata and the published Fetch result will be kept."}
          </div>
          <div className="mt-2 space-y-1 text-xs">
            {archivedRoots.map((root) => (
              <div key={root.folderId} className="truncate" title={root.archivePath}>
                {root.archivePath}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setArchiveDeleteStep(0)}>
              Cancel
            </Button>
            {archiveDeleteStep === 1 ? (
              <Button size="sm" variant="outline" onClick={() => setArchiveDeleteStep(2)}>
                Continue
              </Button>
            ) : (
              <Button
                size="sm"
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void reviewArchive("delete_archived")}
              >
                Permanently delete
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunLogs({
  run,
  nodeRuns,
  events,
}: {
  run: WorkflowRunDetail | WorkflowRun;
  nodeRuns: WorkflowNodeRun[];
  events: WorkflowEvent[];
}) {
  const entries =
    events.length > 0
      ? events.map((event) => ({
          time: event.createdAt,
          level: event.level,
          message: event.message,
          detail: summarizeJSON(event.detailJson),
          type: event.eventType,
        }))
      : [
          { time: run.createdAt, level: "info", message: `Run created: ${run.displayName}`, detail: run.triggerReason },
          ...nodeRuns.map((node) => ({
            time: node.startedAt || node.createdAt,
            level:
              node.status === "failed"
                ? "error"
                : node.status === "skipped" || node.status === "partial"
                  ? "warn"
                  : "info",
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
          <div
            className={
              entry.level === "error"
                ? "text-error-foreground"
                : entry.level === "warn"
                  ? "text-warning-foreground"
                  : "text-muted-foreground"
            }
          >
            {entry.level}
          </div>
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

type WorkflowCanvasItem = {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  detail: string;
  position?: { x: number; y: number };
  flowing?: boolean;
};

type WorkflowCanvasConnection = {
  id: string;
  source: string;
  target: string;
  dataType: string;
};

function DefinitionNodeCanvas({
  nodes,
  nodeTypes,
  readonly,
  onEditNode,
}: {
  nodes: WorkflowNode[];
  nodeTypes: WorkflowNodeType[];
  readonly: boolean;
  onEditNode: (index: number) => void;
}) {
  const [selectedNodeID, setSelectedNodeID] = useState("");
  const selectedIndex = nodes.findIndex((node, index) => `${node.id}-${index}` === selectedNodeID);
  const selectedNode = selectedIndex >= 0 ? nodes[selectedIndex] : null;
  const canvasNodes = nodes.map((node, index) => ({
    id: `${node.id}-${index}`,
    title: node.displayName || node.id,
    subtitle: nodeSubtitle(node.type, nodeTypes),
    status: "idle",
    detail: summarizeJSON(JSON.stringify(node.config ?? {})) || node.type,
  }));
  return (
    <div className="space-y-2">
      <WorkflowNodeCanvas
        nodes={canvasNodes}
        responsiveLinear
        onNodeClick={setSelectedNodeID}
        onNodeDoubleClick={
          readonly
            ? undefined
            : (nodeID) => {
                const index = canvasNodes.findIndex((node) => node.id === nodeID);
                if (index >= 0) onEditNode(index);
              }
        }
      />
      {selectedNode && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{selectedNode.displayName || selectedNode.id}</div>
            <div className="text-xs text-muted-foreground">{nodeSubtitle(selectedNode.type, nodeTypes)}</div>
          </div>
          {!readonly && (
            <Button size="sm" variant="outline" onClick={() => onEditNode(selectedIndex)}>
              <Edit3 className="h-4 w-4" />
              Edit
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type WorkflowCanvasData = WorkflowCanvasItem &
  Record<string, unknown> & {
    hasIncoming: boolean;
    hasOutgoing: boolean;
    incomingColor: string;
    outgoingColor: string;
    incomingPosition: Position;
    outgoingPosition: Position;
  };
type WorkflowCanvasNode = Node<WorkflowCanvasData, "workflow">;

function WorkflowCanvasRuntimeSync({ nodeIDs, layoutKey }: { nodeIDs: string[]; layoutKey: string }) {
  const nodesInitialized = useNodesInitialized();
  const reactFlow = useReactFlow<WorkflowCanvasNode, Edge>();
  const updateNodeInternals = useUpdateNodeInternals();

  useEffect(() => {
    if (nodeIDs.length === 0) return;
    updateNodeInternals(nodeIDs);
  }, [layoutKey, nodeIDs, updateNodeInternals]);

  useEffect(() => {
    if (!layoutKey || !nodesInitialized || !reactFlow.viewportInitialized) return;
    const frame = window.requestAnimationFrame(() => {
      void reactFlow.fitView({ padding: 0.22, maxZoom: 1, duration: 160 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutKey, nodesInitialized, reactFlow]);

  return null;
}

function WorkflowCanvasNodeView({ data }: NodeProps<WorkflowCanvasNode>) {
  const status = normalizedWorkflowNodeStatus(data.status);
  return (
    <div
      className={`workflow-run-node workflow-run-node--${status} ${data.flowing ? "workflow-run-node--flowing" : ""} group relative flex h-11 min-w-40 max-w-52 items-center gap-2 rounded-md border bg-card px-3 shadow-sm`}
    >
      {data.hasIncoming && (
        <Handle
          id="in"
          type="target"
          position={data.incomingPosition}
          className="!h-3 !w-3 !border-2 !border-card"
          style={{ background: data.incomingColor }}
          aria-hidden
        />
      )}
      <StatusPoint status={data.status} />
      <span className="truncate text-sm font-medium">{data.title}</span>
      {data.hasOutgoing && (
        <Handle
          id="out"
          type="source"
          position={data.outgoingPosition}
          className="!h-3 !w-3 !border-2 !border-card"
          style={{ background: data.outgoingColor }}
          aria-hidden
        />
      )}
      <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 hidden w-64 -translate-x-1/2 rounded-md border bg-popover p-3 text-left shadow-lg group-hover:block group-focus-within:block">
        <div className="text-sm font-semibold">{data.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{data.subtitle}</div>
        <div className="mt-2 break-words text-xs text-muted-foreground">{data.detail}</div>
      </div>
    </div>
  );
}

const workflowCanvasNodeTypes = { workflow: WorkflowCanvasNodeView };

type WorkflowLinearPreviewLayout = {
  positions: { x: number; y: number }[];
  incomingPositions: Position[];
  outgoingPositions: Position[];
  height: number;
};

function positionToward(origin: { x: number; y: number }, target: { x: number; y: number }) {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  if (Math.abs(deltaY) > Math.abs(deltaX)) return deltaY > 0 ? Position.Bottom : Position.Top;
  return deltaX > 0 ? Position.Right : Position.Left;
}

function workflowLinearPreviewLayout(nodeCount: number, width: number): WorkflowLinearPreviewLayout {
  const nodeWidth = 176;
  const horizontalGap = 56;
  const verticalStep = 88;
  const usableWidth = Math.max(220, width - 80);
  const columns = Math.max(
    1,
    Math.min(nodeCount, Math.floor((usableWidth + horizontalGap) / (nodeWidth + horizontalGap))),
  );
  const rows = Math.max(1, Math.ceil(nodeCount / columns));
  const positions = Array.from({ length: nodeCount }, (_, index) => {
    const row = Math.floor(index / columns);
    const offset = index % columns;
    const column = row % 2 === 0 ? offset : columns - 1 - offset;
    return { x: column * (nodeWidth + horizontalGap), y: 48 + row * verticalStep };
  });
  const incomingPositions = positions.map((position, index) =>
    index === 0 ? Position.Left : positionToward(position, positions[index - 1]),
  );
  const outgoingPositions = positions.map((position, index) =>
    index === positions.length - 1 ? Position.Right : positionToward(position, positions[index + 1]),
  );
  return { positions, incomingPositions, outgoingPositions, height: rows * verticalStep + 96 };
}

function WorkflowNodeCanvas({
  nodes,
  connections,
  onNodeClick,
  onNodeDoubleClick,
  compact = false,
  responsiveLinear = false,
}: {
  nodes: WorkflowCanvasItem[];
  connections?: WorkflowCanvasConnection[];
  onNodeClick?: (nodeID: string) => void;
  onNodeDoubleClick?: (nodeID: string) => void;
  compact?: boolean;
  responsiveLinear?: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    if (!responsiveLinear || !canvasRef.current) return;
    const observer = new ResizeObserver((entries) => setCanvasWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [responsiveLinear]);
  const responsiveLayout = useMemo(
    () => (responsiveLinear && canvasWidth > 0 ? workflowLinearPreviewLayout(nodes.length, canvasWidth) : null),
    [canvasWidth, nodes.length, responsiveLinear],
  );
  const resolvedConnections = useMemo<WorkflowCanvasConnection[]>(
    () =>
      connections ??
      nodes.slice(0, -1).map((node, index) => ({
        id: `${node.id}->${nodes[index + 1].id}`,
        source: node.id,
        target: nodes[index + 1].id,
        dataType: "dynamic",
      })),
    [connections, nodes],
  );
  const incomingByNode = useMemo(
    () => new Map(nodes.map((node) => [node.id, resolvedConnections.filter((edge) => edge.target === node.id)])),
    [nodes, resolvedConnections],
  );
  const outgoingByNode = useMemo(
    () => new Map(nodes.map((node) => [node.id, resolvedConnections.filter((edge) => edge.source === node.id)])),
    [nodes, resolvedConnections],
  );
  const flowNodes = useMemo<WorkflowCanvasNode[]>(
    () =>
      nodes.map((node, index) => ({
        id: node.id,
        type: "workflow",
        data: {
          ...node,
          hasIncoming: (incomingByNode.get(node.id)?.length ?? 0) > 0,
          hasOutgoing: (outgoingByNode.get(node.id)?.length ?? 0) > 0,
          incomingColor: workflowDataTypeColor(incomingByNode.get(node.id)?.[0]?.dataType),
          outgoingColor: workflowDataTypeColor(outgoingByNode.get(node.id)?.[0]?.dataType),
          incomingPosition: responsiveLayout?.incomingPositions[index] ?? Position.Left,
          outgoingPosition: responsiveLayout?.outgoingPositions[index] ?? Position.Right,
        },
        position: responsiveLayout?.positions[index] ?? node.position ?? { x: index * 210, y: 48 },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        selectable: true,
      })),
    [incomingByNode, nodes, outgoingByNode, responsiveLayout],
  );
  const nodeByID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const layoutKey = useMemo(
    () =>
      flowNodes
        .map(
          (node) =>
            `${node.id}:${node.position.x}:${node.position.y}:${node.data.hasIncoming ? node.data.incomingPosition : "none"}:${node.data.hasOutgoing ? node.data.outgoingPosition : "none"}`,
        )
        .join("|"),
    [flowNodes],
  );
  const nodeIDs = useMemo(() => flowNodes.map((node) => node.id), [flowNodes]);
  const edges = useMemo<Edge[]>(
    () =>
      resolvedConnections.map((connection) => {
        const source = nodeByID.get(connection.source);
        const target = nodeByID.get(connection.target);
        const state = workflowRunEdgeState(source, target);
        const color = workflowDataTypeColor(connection.dataType);
        return {
          id: connection.id,
          source: connection.source,
          sourceHandle: "out",
          target: connection.target,
          targetHandle: "in",
          type: "bezier",
          className: workflowEdgeClassName(state),
          style: { stroke: color, strokeWidth: 2, "--workflow-edge-color": color } as CSSProperties,
          animated: state === "active",
        };
      }),
    [nodeByID, resolvedConnections],
  );

  return (
    <div
      ref={canvasRef}
      className={`workflow-canvas overflow-hidden rounded-md border ${responsiveLayout ? "" : compact ? "h-48" : "h-64"}`}
      style={responsiveLayout ? { height: responsiveLayout.height } : undefined}
      aria-label="Workflow node canvas"
    >
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        nodeTypes={workflowCanvasNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnDoubleClick={false}
        minZoom={responsiveLinear ? 0.7 : 0.45}
        maxZoom={1.5}
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
        onNodeDoubleClick={(_, node) => onNodeDoubleClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <WorkflowCanvasRuntimeSync nodeIDs={nodeIDs} layoutKey={layoutKey} />
        <Background gap={20} size={1} color="hsl(var(--workflow-grid))" />
        <WorkflowViewportTools compact={compact} />
      </ReactFlow>
    </div>
  );
}

function workflowRunEdgeState(
  source: WorkflowCanvasItem | undefined,
  target: WorkflowCanvasItem | undefined,
): WorkflowEdgeVisualState {
  if (!source || !target) return "idle";
  if (target.flowing || normalizedWorkflowNodeStatus(target.status) === "running") return "active";
  if (normalizedWorkflowNodeStatus(target.status) === "failed") return "failed";
  if (normalizedWorkflowNodeStatus(target.status) === "skipped") return "skipped";
  const sourceStatus = normalizedWorkflowNodeStatus(source.status);
  const targetStatus = normalizedWorkflowNodeStatus(target.status);
  if (["succeeded", "partial"].includes(sourceStatus) && ["succeeded", "partial"].includes(targetStatus))
    return "completed";
  return "idle";
}

function normalizedWorkflowNodeStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return ["queued", "running", "succeeded", "partial", "failed", "skipped"].includes(normalized) ? normalized : "idle";
}

function StatusPoint({ status }: { status: string }) {
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-info" aria-label="Running" />;
  const color =
    status === "succeeded"
      ? "bg-success"
      : status === "failed"
        ? "bg-error"
        : status === "partial"
          ? "bg-warning"
          : "bg-muted-foreground/45";
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color}`} aria-label={status} />;
}

function RecentWorkflowRuns({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (run: WorkflowRun) => void }) {
  return (
    <section className="space-y-2">
      <div className="text-sm font-semibold">Recent runs</div>
      <div className="divide-y rounded-md border">
        {runs.map((run) => (
          <button
            key={run.id}
            className="grid w-full gap-1 px-3 py-2 text-left hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3"
            onClick={() => onOpen(run)}
          >
            <span className="min-w-0 truncate text-sm font-medium">
              #{run.id} {run.triggerReason || run.displayName}
            </span>
            <span className="text-xs text-muted-foreground">{formatRunTime(run)}</span>
            <StatusBadge status={run.status} />
          </button>
        ))}
        {runs.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">No recent runs.</div>}
      </div>
    </section>
  );
}

function supportedAutomationTriggerTypes(definition: WorkflowDefinition): AutomationTriggerType[] {
  if (definition.scope === "system" && definition.code === "availability_watch") return ["schedule"];
  if (definition.scope === "system" && definition.code === "local_library_scan")
    return ["startup", "filesystem_event", "schedule"];
  if (definition.scope === "system" && configurableSystemWorkflowCodes.has(definition.code))
    return automationTriggerTypes;
  if (definition.scope !== "user" || !definition.editable) return [];
  return parseWorkflowDefinition(definition.definitionJson).kind === "v2" ? automationTriggerTypes : [];
}

function workflowDefinitionAutomationModes(
  triggers: WorkflowTrigger[],
): Array<"manual" | "startup" | "watching" | "schedule"> {
  const enabledTriggers = triggers.filter((trigger) => trigger.enabled);
  const modes: Array<"startup" | "watching" | "schedule"> = [];
  if (enabledTriggers.some((trigger) => trigger.triggerType === "startup")) modes.push("startup");
  if (enabledTriggers.some((trigger) => trigger.triggerType === "filesystem_event")) modes.push("watching");
  if (enabledTriggers.some((trigger) => trigger.triggerType === "schedule")) modes.push("schedule");
  return modes.length > 0 ? modes : ["manual"];
}

function workflowTriggerCondition(trigger: WorkflowTrigger) {
  if (trigger.triggerType === "startup") return "When the application service starts";
  if (trigger.triggerType === "filesystem_event") return "When local library folders change";
  if (trigger.triggerType === "schedule") {
    const interval = parseJSONRecord(trigger.scheduleJson).intervalMinutes;
    if (typeof interval === "number") return `Every ${interval} minute${interval === 1 ? "" : "s"}`;
    return "Interval schedule";
  }
  return trigger.triggerType.replace(/_/g, " ");
}

function workflowTriggerNextRun(trigger: WorkflowTrigger) {
  if (!trigger.enabled) return "Paused";
  if (trigger.triggerType === "startup") return "Next service start";
  if (trigger.triggerType === "filesystem_event") return "Watching for folder changes";
  return trigger.nextRunAt ?? "Pending calculation";
}

function WorkflowAutomationPanel({
  definition,
  triggers,
  canManage,
  onCreate,
  onEdit,
  onToggle,
}: {
  definition: WorkflowDefinition;
  triggers: WorkflowTrigger[];
  canManage: boolean;
  onCreate: (triggerType: CreatableAutomationTriggerType) => void;
  onEdit: (trigger: WorkflowTrigger) => void;
  onToggle: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
}) {
  const supportedTypes = supportedAutomationTriggerTypes(definition);
  const hasStartup = triggers.some((trigger) => trigger.triggerType === "startup");
  const hasSchedule = triggers.some((trigger) => trigger.triggerType === "schedule");
  const orderedTriggers = [...triggers].sort((left, right) => {
    const leftOrder =
      left.triggerType === "startup"
        ? 0
        : left.triggerType === "filesystem_event"
          ? 1
          : left.triggerType === "schedule"
            ? 2
            : 3;
    const rightOrder =
      right.triggerType === "startup"
        ? 0
        : right.triggerType === "filesystem_event"
          ? 1
          : right.triggerType === "schedule"
            ? 2
            : 3;
    return leftOrder - rightOrder || left.id - right.id;
  });
  return (
    <section className="border-b pb-5 pt-4" aria-label="Workflow automations">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold">Triggers</div>
          <div className="text-xs text-muted-foreground">Automatic execution conditions for this workflow.</div>
        </div>
        {canManage && supportedTypes.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {supportedTypes.includes("startup") && !hasStartup && (
              <Button size="sm" variant="outline" onClick={() => onCreate("startup")}>
                <Plus className="h-4 w-4" />
                Run at startup
              </Button>
            )}
            {supportedTypes.includes("schedule") && (definition.code !== "availability_watch" || !hasSchedule) && (
              <Button size="sm" variant="outline" onClick={() => onCreate("schedule")}>
                <CalendarClock className="h-4 w-4" />
                Add schedule
              </Button>
            )}
          </div>
        )}
      </div>

      {orderedTriggers.length > 0 ? (
        <div className="mt-3 divide-y">
          {orderedTriggers.map((trigger) => (
            <div
              key={trigger.id}
              className="grid gap-3 py-3 md:grid-cols-[minmax(180px,1fr)_minmax(0,1.6fr)_auto] md:items-center"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Switch
                  checked={trigger.enabled}
                  disabled={!canManage || !supportedTypes.includes(trigger.triggerType as AutomationTriggerType)}
                  onCheckedChange={(enabled) => void onToggle(trigger, enabled)}
                  aria-label={`${trigger.enabled ? "Pause" : "Enable"} ${trigger.displayName}`}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{trigger.displayName}</div>
                  <div className="text-xs capitalize text-muted-foreground">
                    {trigger.triggerType.replace(/_/g, " ")}
                  </div>
                </div>
              </div>
              <div className="grid min-w-0 gap-1 text-xs sm:grid-cols-3 sm:gap-3">
                <SummaryCell label="Runs" value={workflowTriggerCondition(trigger)} />
                <SummaryCell label="Next" value={workflowTriggerNextRun(trigger)} />
                <SummaryCell label="Last success" value={trigger.lastSuccessAt ?? "Never"} />
              </div>
              {canManage &&
                trigger.triggerType !== "filesystem_event" &&
                supportedTypes.includes(trigger.triggerType as AutomationTriggerType) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onEdit(trigger)}
                    title={`Edit ${trigger.displayName}`}
                    aria-label={`Edit ${trigger.displayName}`}
                  >
                    <Edit3 className="h-4 w-4" />
                  </Button>
                )}
              {trigger.lastErrorMessage && (
                <div className="text-xs text-error-foreground md:col-start-2 md:col-end-4">
                  Last error: {trigger.lastErrorMessage}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 py-3 text-sm text-muted-foreground">
          {supportedTypes.length > 0
            ? "No automatic triggers configured."
            : "This workflow has no configurable automatic triggers."}
        </div>
      )}
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-words text-sm font-medium">{value}</div>
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
  const [nodes, setNodes] = useState<WorkflowNode[]>(
    definition ? parseNodes(definition.definitionJson) : workflowTemplates[1].nodes,
  );
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
      const saved = definition
        ? await api.updateWorkflowDefinition(definition.id, payload)
        : await api.createWorkflowDefinition(payload);
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
            <input
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value={code}
              disabled={!!definition}
              onChange={(event) => setCode(event.target.value)}
            />
          </Field>
          <Field label="Name">
            <input
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
        </div>
        {!definition && (
          <Field label="Template">
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={templateId}
              onChange={(event) => {
                setTemplateID(event.target.value);
                setNodes(
                  workflowTemplates.find((template) => template.id === event.target.value)?.nodes ??
                    workflowTemplates[0].nodes,
                );
              }}
            >
              {workflowTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Description">
          <textarea
            className="min-h-20 rounded-md border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
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
                  <option key={phase} value={phase}>
                    {phase}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setNodes((current) => [...current, createSuggestedNode(current, nodeTypes, insertPhase)])
                }
              >
                <Plus className="h-4 w-4" />
                Add node
              </Button>
            </div>
          </div>
          <WorkflowHints nodes={nodes} nodeTypes={nodeTypes} />
          <div className="grid gap-2">
            {nodes.map((node, index) => (
              <NodeInlineEditor
                key={`${node.id}-${index}`}
                node={node}
                nodeTypes={nodeTypes}
                onChange={(patch) => setNodes(updateNodes(nodes, index, patch))}
                onRemove={() => setNodes(nodes.filter((_, nodeIndex) => nodeIndex !== index))}
              />
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
  definition,
  trigger,
  initialTriggerType,
  onClose,
  onSaved,
  onDeleted,
}: {
  definition: WorkflowDefinition;
  trigger: WorkflowTrigger | null;
  initialTriggerType: CreatableAutomationTriggerType;
  onClose: () => void;
  onSaved: (trigger: WorkflowTrigger) => void;
  onDeleted: () => void;
}) {
  const triggerType: CreatableAutomationTriggerType =
    trigger?.triggerType === "startup" ? "startup" : initialTriggerType;
  const selectedParsed = parseWorkflowDefinition(definition.definitionJson);
  const dagDocument = selectedParsed.kind === "v2" ? selectedParsed.document : null;
  const [systemConfig, setSystemConfig] = useState<SystemWorkflowTriggerConfig>(() =>
    workflowSystemTriggerConfig(definition.code, trigger),
  );
  const [displayName, setDisplayName] = useState(
    trigger?.displayName ?? (triggerType === "startup" ? "Run at startup" : "Scheduled workflow"),
  );
  const [enabled, setEnabled] = useState(trigger?.enabled ?? true);
  const [intervalMinutes, setIntervalMinutes] = useState(() => {
    const value = parseJSONRecord(trigger?.scheduleJson ?? "").intervalMinutes;
    return typeof value === "number" ? value : 60;
  });
  const [scheduledInputs, setScheduledInputs] = useState<Record<string, string>>(() => {
    const inputs = parseJSONRecord(trigger?.configJson ?? "").inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      return Object.fromEntries(
        dagDocument?.inputs.flatMap((input) =>
          input.defaultValue === undefined ? [] : [[input.key, input.defaultValue]],
        ) ?? [],
      );
    }
    return Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(", ") : String(value ?? ""),
      ]),
    );
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const missingScheduledInputs =
    dagDocument?.inputs.filter((input) => input.required && !scheduledInputs[input.key]?.trim()) ?? [];
  const invalidScheduledInputs =
    dagDocument?.inputs.filter(
      (input) => input.type === "work_codes" && parseWorkCodes(scheduledInputs[input.key] ?? "").invalid.length > 0,
    ) ?? [];
  const systemConfigBlockers = workflowSystemTriggerConfigBlockers(definition.code, systemConfig);
  const automationBlockers = [
    ...(dagDocument?.policy.requirePreview ? ["Disable Require preview in the workflow before automating it."] : []),
    ...(triggerType === "schedule" && (intervalMinutes < 5 || intervalMinutes > 10080)
      ? ["Interval must be between 5 and 10080 minutes."]
      : []),
    ...(missingScheduledInputs.length > 0
      ? [`Provide required inputs: ${missingScheduledInputs.map((input) => input.label).join(", ")}.`]
      : []),
    ...(invalidScheduledInputs.length > 0
      ? [`Fix invalid work codes in: ${invalidScheduledInputs.map((input) => input.label).join(", ")}.`]
      : []),
    ...systemConfigBlockers,
  ];

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (automationBlockers.length > 0) throw new Error(automationBlockers[0]);
      const resolvedInputs = dagDocument
        ? Object.fromEntries(
            dagDocument.inputs.flatMap((input) => {
              const value = scheduledInputs[input.key]?.trim() ?? "";
              return !input.required && value === "" ? [] : [[input.key, value]];
            }),
          )
        : null;
      const payload = {
        workflowDefinitionId: definition.id,
        displayName,
        triggerType,
        enabled,
        scheduleJson:
          triggerType === "schedule"
            ? JSON.stringify({ intervalMinutes })
            : (trigger?.scheduleJson ?? JSON.stringify({ type: "startup" })),
        configJson: dagDocument
          ? JSON.stringify({ inputs: resolvedInputs })
          : JSON.stringify(workflowSystemTriggerConfigPayload(definition.code, systemConfig)),
        nextRunAt: null,
      };
      const saved = trigger
        ? await api.updateWorkflowTrigger(trigger.id, payload)
        : await api.createWorkflowTrigger(payload);
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
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={trigger ? "Edit trigger" : triggerType === "startup" ? "New startup trigger" : "New schedule"}
      onClose={onClose}
    >
      <div className="grid gap-3">
        <div className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-xs text-muted-foreground">Workflow</div>
          <div className="text-sm font-medium">{definition.displayName}</div>
        </div>
        <Field label="Name">
          <input
            className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          {triggerType === "schedule" ? (
            <Field label="Interval (minutes)">
              <input
                className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                type="number"
                min={5}
                max={10080}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
              />
            </Field>
          ) : (
            <div className="grid gap-1 rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-xs text-muted-foreground">Runs</div>
              <div className="text-sm font-medium">When the application service starts</div>
            </div>
          )}
          <div className="flex items-center gap-2 self-end pb-1 text-sm">
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable trigger" />
            <span>Enabled</span>
          </div>
        </div>
        {dagDocument && dagDocument.inputs.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {dagDocument.inputs.map((input) => (
              <Field key={input.key} label={`${input.label}${input.required ? " *" : ""}`}>
                {input.type === "work_codes" ? (
                  <WorkCodesField
                    value={scheduledInputs[input.key] ?? ""}
                    onChange={(value) => setScheduledInputs((current) => ({ ...current, [input.key]: value }))}
                  />
                ) : (
                  <input
                    className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={scheduledInputs[input.key] ?? ""}
                    onChange={(event) =>
                      setScheduledInputs((current) => ({ ...current, [input.key]: event.target.value }))
                    }
                  />
                )}
              </Field>
            ))}
          </div>
        )}
        <SystemWorkflowTriggerFields definitionCode={definition.code} value={systemConfig} onChange={setSystemConfig} />
        {automationBlockers.length > 0 && (
          <div className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {automationBlockers.map((blocker) => (
              <div key={blocker}>{blocker}</div>
            ))}
          </div>
        )}
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2">
          {trigger && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button onClick={save} disabled={saving || automationBlockers.length > 0 || !displayName.trim()}>
            <Save className="h-4 w-4" />
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function workflowSystemTriggerConfig(
  definitionCode: string,
  trigger: WorkflowTrigger | null,
): SystemWorkflowTriggerConfig {
  const record = parseJSONRecord(trigger?.configJson ?? "");
  const period = ["day", "week", "month", "year"].includes(String(record.period))
    ? (record.period as DLsitePopularPeriod)
    : "day";
  const defaultTemplate =
    definitionCode === "dlsite_popular_collection"
      ? dlsitePopularDefaultTagTemplate(period)
      : REMOTE_POPULAR_TAG_TEMPLATE;
  return {
    followUpRun: record.followUpRun === true,
    sourceId: typeof record.sourceId === "number" ? record.sourceId : 0,
    action: record.action === "fetch" ? "fetch" : "track",
    limit: typeof record.limit === "number" ? record.limit : 25,
    period,
    releaseWindow: record.releaseWindow === "30d" ? "30d" : "",
    year: typeof record.year === "number" ? record.year : new Date().getUTCFullYear(),
    tagNameTemplate:
      typeof record.tagNameTemplate === "string" && record.tagNameTemplate.trim()
        ? record.tagNameTemplate
        : defaultTemplate,
  };
}

function workflowSystemTriggerConfigPayload(definitionCode: string, value: SystemWorkflowTriggerConfig) {
  if (definitionCode === "local_library_scan") {
    return { followUpRun: value.followUpRun };
  }
  if (definitionCode === "remote_popular_collection") {
    return {
      sourceId: value.sourceId,
      action: value.action,
      limit: value.limit,
      tagNameTemplate: value.tagNameTemplate.trim(),
    };
  }
  if (definitionCode === "dlsite_popular_collection") {
    return {
      period: value.period,
      releaseWindow: value.period === "year" ? "" : value.releaseWindow,
      year: value.period === "year" ? value.year : 0,
      tagNameTemplate: value.tagNameTemplate.trim(),
    };
  }
  return {};
}

function workflowSystemTriggerConfigBlockers(definitionCode: string, value: SystemWorkflowTriggerConfig) {
  if (definitionCode === "remote_popular_collection") {
    return [
      ...(value.sourceId <= 0 ? ["Select a remote source."] : []),
      ...(value.action === "fetch" ? ["Automated remote collection supports Track only."] : []),
      ...(value.limit <= 0 || value.limit > 100 ? ["Work limit must be between 1 and 100."] : []),
      ...workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "remote_name", "source_code", "action"]),
    ];
  }
  if (definitionCode === "dlsite_popular_collection") {
    return [
      ...(value.period === "year" && (value.year < 2000 || value.year > new Date().getUTCFullYear())
        ? [`Year must be between 2000 and ${new Date().getUTCFullYear()}.`]
        : []),
      ...workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "period", "release_window", "year"]),
    ];
  }
  return [];
}

function workflowTagTemplateBlockers(template: string, tokens: string[]) {
  if (!template.trim()) return ["Tag template is required."];
  if ([...template].length > TAG_TEMPLATE_MAX_LENGTH)
    return [`Tag template must be at most ${TAG_TEMPLATE_MAX_LENGTH} characters.`];
  const matches = template.match(/\{[a-z_]+\}/g) ?? [];
  const unsupported = matches.find((token) => !tokens.includes(token.slice(1, -1)));
  if (unsupported) return [`Unsupported tag template token: ${unsupported}.`];
  if (/[{}]/.test(template.replace(/\{[a-z_]+\}/g, ""))) return ["Tag template contains an invalid token."];
  return [];
}

function SystemWorkflowTriggerFields({
  definitionCode,
  value,
  onChange,
}: {
  definitionCode: string;
  value: SystemWorkflowTriggerConfig;
  onChange: (value: SystemWorkflowTriggerConfig) => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loadingSources, setLoadingSources] = useState(definitionCode === "remote_popular_collection");
  const compatibleSources = useMemo(
    () =>
      sources.filter(
        (source) =>
          source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
      ),
    [sources],
  );

  useEffect(() => {
    if (definitionCode !== "remote_popular_collection") return;
    let active = true;
    api
      .listLibrarySources()
      .then((items) => {
        if (!active) return;
        setSources(items);
        const compatible = items.filter(
          (source) =>
            source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
        );
        if (value.sourceId <= 0 && compatible[0]) onChange({ ...value, sourceId: compatible[0].id });
      })
      .catch(() => {
        if (active) setSources([]);
      })
      .finally(() => {
        if (active) setLoadingSources(false);
      });
    return () => {
      active = false;
    };
  }, [definitionCode]);

  if (definitionCode === "local_library_scan") {
    return (
      <div className="flex items-center justify-between gap-4 border-t pt-3">
        <div>
          <div className="text-sm font-medium">Follow-up run</div>
          <div className="text-xs text-muted-foreground">
            Queue an independent metadata sync after each scan completes.
          </div>
        </div>
        <Switch
          checked={value.followUpRun}
          onCheckedChange={(followUpRun) => onChange({ ...value, followUpRun })}
          aria-label="Follow-up run"
        />
      </div>
    );
  }

  if (definitionCode === "remote_popular_collection") {
    const selectedSource = compatibleSources.find((source) => source.id === value.sourceId);
    const tokens = remotePopularTagTemplateTokens(selectedSource, value.action, new Date());
    const preview = workflowTagTemplatePreview(value.tagNameTemplate, workflowTagTemplateTokenValues(tokens));
    const error = workflowTagTemplateBlockers(
      value.tagNameTemplate,
      tokens.map((token) => token.name),
    )[0];
    return (
      <div className="grid gap-3 border-t pt-3 md:grid-cols-2">
        <Field label="Remote source">
          <select
            className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={value.sourceId}
            disabled={loadingSources || compatibleSources.length === 0}
            onChange={(event) => onChange({ ...value, sourceId: Number(event.target.value) })}
          >
            {compatibleSources.length === 0 && (
              <option value={0}>{loadingSources ? "Loading sources" : "No compatible source"}</option>
            )}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Action">
          <select
            className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={value.action}
            onChange={(event) => onChange({ ...value, action: event.target.value === "fetch" ? "fetch" : "track" })}
          >
            <option value="track">Track</option>
            <option value="fetch" disabled>
              Fetch (manual only)
            </option>
          </select>
        </Field>
        <Field label="Work limit">
          <select
            className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={value.limit}
            onChange={(event) => onChange({ ...value, limit: Number(event.target.value) })}
          >
            {[10, 25, 50, 100].map((limit) => (
              <option key={limit} value={limit}>
                {limit} works
              </option>
            ))}
          </select>
        </Field>
        <TagTemplateField
          id="remote-trigger-tag-template"
          value={value.tagNameTemplate}
          defaultValue={REMOTE_POPULAR_TAG_TEMPLATE}
          tokens={tokens}
          preview={preview}
          error={error}
          onChange={(tagNameTemplate) => onChange({ ...value, tagNameTemplate })}
        />
      </div>
    );
  }

  if (definitionCode === "dlsite_popular_collection") {
    const defaultTemplate = dlsitePopularDefaultTagTemplate(value.period);
    const tokens = dlsitePopularTagTemplateTokens(value.period, value.releaseWindow, value.year, new Date());
    const preview = workflowTagTemplatePreview(value.tagNameTemplate, workflowTagTemplateTokenValues(tokens));
    const error = workflowTagTemplateBlockers(
      value.tagNameTemplate,
      tokens.map((token) => token.name),
    )[0];
    return (
      <div className="grid gap-3 border-t pt-3 md:grid-cols-2">
        <Field label="Ranking period">
          <select
            className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={value.period}
            onChange={(event) => {
              const period = event.target.value as DLsitePopularPeriod;
              const tagNameTemplate =
                value.tagNameTemplate === dlsitePopularDefaultTagTemplate(value.period)
                  ? dlsitePopularDefaultTagTemplate(period)
                  : value.tagNameTemplate;
              onChange({ ...value, period, tagNameTemplate });
            }}
          >
            <option value="day">24 hours</option>
            <option value="week">7 days</option>
            <option value="month">30 days</option>
            <option value="year">Annual</option>
          </select>
        </Field>
        {value.period === "year" ? (
          <Field label="Ranking year">
            <input
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              type="number"
              min={2000}
              max={new Date().getUTCFullYear()}
              value={value.year}
              onChange={(event) => onChange({ ...value, year: Number(event.target.value) })}
            />
          </Field>
        ) : (
          <Field label="Release window">
            <select
              className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={value.releaseWindow}
              onChange={(event) => onChange({ ...value, releaseWindow: event.target.value === "30d" ? "30d" : "" })}
            >
              <option value="30d">Released in 30 days</option>
              <option value="">All releases</option>
            </select>
          </Field>
        )}
        <TagTemplateField
          id="dlsite-trigger-tag-template"
          value={value.tagNameTemplate}
          defaultValue={defaultTemplate}
          tokens={tokens}
          preview={preview}
          error={error}
          onChange={(tagNameTemplate) => onChange({ ...value, tagNameTemplate })}
        />
      </div>
    );
  }

  return null;
}

function TagTemplateField({
  id,
  value,
  defaultValue,
  tokens,
  preview,
  error,
  spanColumns = true,
  onChange,
}: {
  id: string;
  value: string;
  defaultValue: string;
  tokens: WorkflowTagTemplateToken[];
  preview: WorkflowTagTemplatePreview;
  error?: string;
  spanColumns?: boolean;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const insertToken = (name: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const token = `{${name}}`;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className={`grid min-w-0 gap-3 ${spanColumns ? "md:col-span-2" : ""}`} data-testid={`${id}-field`}>
      <div className="grid min-w-0 gap-1.5 text-sm">
        <div className="flex items-center justify-between gap-2 font-medium">
          <label className="flex items-center gap-1.5" htmlFor={id}>
            <Tag className="h-3.5 w-3.5" />
            Tag template
          </label>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={value === defaultValue}
            onClick={() => onChange(defaultValue)}
            title="Reset tag template"
            aria-label="Reset tag template"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <input
          ref={inputRef}
          id={id}
          className="h-9 w-full rounded-md border bg-card px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          value={value}
          maxLength={TAG_TEMPLATE_MAX_LENGTH}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>

      <div className="grid gap-1.5">
        <div className="text-xs font-medium text-muted-foreground">Available variables</div>
        <div className="divide-y rounded-md border">
          {tokens.map((token) => (
            <button
              key={token.name}
              type="button"
              className="grid w-full min-w-0 gap-0.5 px-2.5 py-2 text-left hover:bg-muted/50 sm:grid-cols-[minmax(135px,0.8fr)_minmax(0,1.2fr)_minmax(90px,0.7fr)] sm:items-center sm:gap-3"
              onClick={() => insertToken(token.name)}
              title={`Insert {${token.name}}`}
            >
              <code className="text-xs font-semibold text-primary">{`{${token.name}}`}</code>
              <span className="text-xs text-muted-foreground">{token.description}</span>
              <code className="min-w-0 truncate text-xs text-foreground sm:text-right" title={token.value}>
                {token.value || "-"}
              </code>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-1 rounded-md bg-muted/35 px-3 py-2" aria-live="polite">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Preview</span>
          <span>
            {Math.min(preview.renderedLength, TAG_NAME_MAX_LENGTH)}/{TAG_NAME_MAX_LENGTH}
          </span>
        </div>
        <code className="break-all text-xs text-foreground">{preview.value || "-"}</code>
        {preview.truncated && (
          <span className="text-xs text-warning-foreground">
            The rendered tag exceeds {TAG_NAME_MAX_LENGTH} characters and will be truncated.
          </span>
        )}
      </div>
      {error && (
        <div className="text-xs text-error-foreground" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function workflowTagTemplatePreview(template: string, values: Record<string, string>): WorkflowTagTemplatePreview {
  const rendered = template.replace(/\{[a-z_]+\}/g, (token) => values[token.slice(1, -1)] ?? token).trim();
  const runes = [...rendered];
  return {
    value: runes.slice(0, TAG_NAME_MAX_LENGTH).join(""),
    renderedLength: runes.length,
    truncated: runes.length > TAG_NAME_MAX_LENGTH,
  };
}

function workflowTagTemplateTokenValues(tokens: WorkflowTagTemplateToken[]) {
  return Object.fromEntries(tokens.map((token) => [token.name, token.value]));
}

function remotePopularTagTemplateTokens(
  source: LibrarySource | undefined | null,
  action: "track" | "fetch",
  now: Date,
): WorkflowTagTemplateToken[] {
  return [
    { name: "date", description: "UTC date (YYMMDD)", value: utcShortDate(now) },
    {
      name: "remote_name",
      description: "Remote source display name",
      value: workflowTagFragmentPreview(source?.displayName ?? "remote"),
    },
    {
      name: "source_code",
      description: "Remote source code",
      value: workflowTagFragmentPreview(source?.code ?? "remote"),
    },
    { name: "action", description: "Collection action", value: action },
  ];
}

function dlsitePopularTagTemplateTokens(
  period: DLsitePopularPeriod,
  releaseWindow: "30d" | "",
  year: number,
  now: Date,
): WorkflowTagTemplateToken[] {
  return [
    { name: "date", description: "UTC date (YYMMDD)", value: utcShortDate(now) },
    {
      name: "period",
      description: "Ranking period",
      value: period === "day" ? "24h" : period === "week" ? "7d" : period === "month" ? "30d" : "year",
    },
    { name: "release_window", description: "Release filter", value: releaseWindow === "30d" ? "r30d" : "all" },
    { name: "year", description: "Ranking year (annual mode)", value: period === "year" ? String(year) : "0" },
  ];
}

function dlsitePopularDefaultTagTemplate(period: DLsitePopularPeriod) {
  return period === "year" ? "{date}_DL_year_{year}_popular" : "{date}_DL_{period}_{release_window}_popular";
}

function workflowTagFragmentPreview(value: string) {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

function utcShortDate(value: Date) {
  return `${String(value.getUTCFullYear()).slice(-2)}${String(value.getUTCMonth() + 1).padStart(2, "0")}${String(value.getUTCDate()).padStart(2, "0")}`;
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
        <input
          className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={node.id}
          onChange={(event) => onChange({ id: event.target.value })}
        />
        <select
          className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={node.type}
          onChange={(event) => onChange({ type: event.target.value, config: {} })}
        >
          {phaseOrder.map((phase) => {
            const options = visibleTypes.filter((type) => type.phase === phase);
            if (options.length === 0) return null;
            return (
              <optgroup key={phase} label={phase}>
                {options.map((option) => (
                  <option key={option.type} value={option.type}>
                    {option.displayName}
                  </option>
                ))}
              </optgroup>
            );
          })}
          {visibleTypes.some((type) => !phaseOrder.includes(type.phase as (typeof phaseOrder)[number])) && (
            <optgroup label="other">
              {visibleTypes
                .filter((type) => !phaseOrder.includes(type.phase as (typeof phaseOrder)[number]))
                .map((option) => (
                  <option key={option.type} value={option.type}>
                    {option.displayName}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
        <input
          className="h-9 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          placeholder="Display name"
          value={node.displayName ?? ""}
          onChange={(event) => onChange({ displayName: event.target.value })}
        />
        {onRemove && (
          <Button size="icon" variant="outline" aria-label="Remove node" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {metadata && (
        <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">
              {metadata.phase} · {metadata.type}
            </div>
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
              {configError && <span className="text-xs text-error-foreground">{configError}</span>}
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
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        No structured config fields.
      </div>
    );
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
              <div
                key={field}
                className="flex h-9 items-center justify-between gap-2 rounded-md border bg-card px-3 text-sm"
              >
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

function WorkflowHints({
  nodes,
  nodeTypes,
  compact = false,
}: {
  nodes: WorkflowNode[];
  nodeTypes: WorkflowNodeType[];
  compact?: boolean;
}) {
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
      <div
        className="app-scroll max-h-[86vh] w-full max-w-3xl overflow-auto rounded-lg border bg-card shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
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

function SegmentedNav({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div
      className={
        compact
          ? "grid grid-cols-4 gap-1 rounded-lg border bg-card p-1 sm:flex sm:gap-2"
          : "flex gap-2 overflow-x-auto rounded-lg border bg-card p-1"
      }
    >
      {children}
    </div>
  );
}

function ViewButton({
  active,
  count,
  mobileLabel,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  count?: number;
  mobileLabel?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  const accessibleLabel = typeof children === "string" && count !== undefined ? `${children} ${count}` : undefined;
  return (
    <button
      className={`inline-flex h-9 min-w-0 shrink-0 items-center justify-center gap-1 rounded-md px-1 text-xs font-medium transition-[color,background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:active:scale-100 sm:gap-2 sm:px-3 sm:text-sm ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      aria-label={accessibleLabel}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="hidden sm:inline-flex">{icon}</span>
      {mobileLabel && <span className="truncate sm:hidden">{mobileLabel}</span>}
      <span className={mobileLabel ? "hidden truncate sm:inline" : "truncate"}>{children}</span>
      {count !== undefined && (
        <span
          className={`min-w-4 rounded px-1 text-[10px] leading-4 ${active ? "bg-primary-foreground/18 text-primary-foreground" : "bg-muted text-muted-foreground"}`}
        >
          <span className="sm:hidden">{count > 99 ? "99+" : count}</span>
          <span className="hidden sm:inline">{count}</span>
        </span>
      )}
    </button>
  );
}

function RunMetrics({ run }: { run: WorkflowRun }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Metric
        icon={<ListChecks className="h-3.5 w-3.5" />}
        label="nodes"
        value={`${run.completedNodeRuns}/${run.nodeRunCount}`}
      />
      <Metric icon={<Database className="h-3.5 w-3.5" />} label="jobs" value={`${run.completedJobs}/${run.jobCount}`} />
      <Metric icon={<Activity className="h-3.5 w-3.5" />} label="review" value={`${pendingReviewCount(run)}`} />
    </div>
  );
}

function RunActions({ run, onRunAction }: { run: WorkflowRun; onRunAction: () => Promise<void> }) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancellable = ["queued", "running"].includes(run.status);
  const destructiveCleanup = [
    "media_location_cleanup",
    "media_cleanup_forget_work",
    "media_cache_cleanup",
    "media_cache_limit_cleanup",
    "cache_orphan_cleanup",
    "local_media_delete",
    "local_location_cleanup",
  ].includes(run.workflowCode);
  const retryable =
    (run.status === "failed" ||
      (run.status === "partial" && run.workflowCode === "remote_work_fetch" && run.pendingCandidates > 0)) &&
    [
      "local_library_scan",
      "metadata_sync",
      "remote_work_fetch",
      "media_cache",
      "media_cache_cleanup",
      "media_location_cleanup",
      "media_cleanup_forget_work",
      "local_media_delete",
      "local_location_cleanup",
      "remote_popular_collection",
    ].includes(run.workflowCode);
  if (!cancellable && !retryable) {
    return null;
  }
  const cancel = async () => {
    await api.cancelWorkflowRun(run.id);
    setConfirmingCancel(false);
    await onRunAction();
  };
  return (
    <>
      <div className="flex justify-end gap-2">
        {cancellable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (destructiveCleanup) setConfirmingCancel(true);
              else void cancel();
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
      {confirmingCancel && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/20 p-4 backdrop-blur-sm">
          <div
            className="w-full max-w-md rounded-lg border bg-card p-4 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cancel-run-${run.id}-title`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id={`cancel-run-${run.id}-title`} className="font-semibold">
                  Cancel deletion workflow?
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Cancelling will not restore files already deleted. Completed deletions cannot be undone; cancellation
                  only stops deletions that have not started.
                </p>
                {run.workflowCode === "media_cleanup_forget_work" && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    If the forget step has not started, it will be skipped.
                  </p>
                )}
              </div>
              <Button size="icon" variant="ghost" aria-label="Close" onClick={() => setConfirmingCancel(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmingCancel(false)}>
                Keep running
              </Button>
              <Button variant="destructive" onClick={() => void cancel()}>
                Cancel workflow
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
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
    status === "failed"
      ? "error"
      : status === "partial" || status === "disabled"
        ? "warning"
        : status === "succeeded" || status === "enabled"
          ? "success"
          : status === "running" || status === "queued"
            ? "info"
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
  return (
    <div className="min-w-0 break-words rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground [overflow-wrap:anywhere]">
      {error}
    </div>
  );
}

function JsonPreview({ value, empty, compact = false }: { value: string; empty: string; compact?: boolean }) {
  const summary = summarizeJSON(value);
  if (!summary) {
    return <div className="mt-2 text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <pre
      className={`app-scroll mt-2 min-w-0 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border bg-background p-3 text-xs text-muted-foreground [overflow-wrap:anywhere] ${compact ? "max-h-32" : "max-h-56"}`}
    >
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
  const phases = phaseOrder.filter((phase) =>
    nodeTypes.some((nodeType) => nodeType.userVisible && nodeType.phase === phase),
  );
  return phases.length > 0 ? phases : ["filter"];
}

function recommendedNextPhase(nodes: WorkflowNode[], nodeTypes: WorkflowNodeType[]) {
  const phases = availableInsertPhases(nodeTypes);
  if (nodes.length === 0) {
    return phases.includes("target") ? "target" : phases[0];
  }
  const lastKnownNode = [...nodes]
    .reverse()
    .map((node) => nodeTypes.find((nodeType) => nodeType.type === node.type))
    .find(Boolean);
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
  return (
    type
      .replace(/^(select|discover|filter|match|plan|materialize|verify|sync|cleanup|dispatch)_/, "")
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "") || "node"
  );
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
      hints.push(
        `${nodeID || metadata.displayName} moves from a later phase back to ${metadata.phase}; that is allowed, but check the data flow.`,
      );
    }
    if (phaseIndex >= 0) {
      lastPhaseIndex = Math.max(lastPhaseIndex, phaseIndex);
    }
  });

  if (!hasTarget) {
    hints.push("Consider starting with a target node so the run has an explicit source or work set.");
  }
  if (!hasCommit) {
    hints.push(
      "This workflow has no commit node; it may inspect or materialize data without persisting library state.",
    );
  }
  return hints.slice(0, 5);
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
) {
  if (surface === "activity") {
    const path = view === "running" ? "/activity" : `/activity?view=${encodeURIComponent(view)}`;
    window.history.pushState({}, "", path);
  }
  setActivityView(view);
  setRunPage(1);
  setSelectedRunID(null);
}

function activityViewFromLocation(): ActivityView {
  const value = new URLSearchParams(window.location.search).get("view");
  return activityViews.includes(value as ActivityView) ? (value as ActivityView) : "running";
}

function pendingReviewCount(run: WorkflowRun) {
  return run.pendingCandidates;
}

function candidateNeedsReview(candidate: WorkflowCandidate) {
  return !["accepted", "rejected", "ignored", "resolved"].includes(candidate.status);
}

type LocalCleanupLocation = { locationId: number; path: string; sizeBytes: number | null };
type LocalDuplicateFolder = { relPath: string; files: number; audioFiles: number; sizeBytes: number | null };
type LocalArchivedRoot = {
  folderId: number;
  originalPath: string;
  archivePath: string;
  fileCount: number;
  sizeBytes: number | null;
  files: Array<{ path: string; sizeBytes: number | null }>;
};

function parseJSONRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
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

function activityRunIDFromLocation() {
  const value = Number(new URLSearchParams(window.location.search).get("run"));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function openActivityRun(run: WorkflowRun) {
  const view = activityViewForRun(run);
  const search = new URLSearchParams({ view, run: String(run.id) });
  window.history.pushState({}, "", `/activity?${search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openRemoteSourceConfiguration(sourceID: number) {
  const search = new URLSearchParams({ tab: "library", source: String(sourceID) });
  window.history.pushState({}, "", `/maintenance?${search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function selectActivityRun(run: WorkflowRun, view: ActivityView, setSelectedRunID: (id: number | null) => void) {
  setSelectedRunID(run.id);
  const search = new URLSearchParams(window.location.search);
  search.set("view", view);
  search.set("run", String(run.id));
  window.history.replaceState(window.history.state, "", `/activity?${search}`);
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
    const files = Array.isArray(record.files)
      ? record.files.flatMap((file) => {
          if (!file || typeof file !== "object" || Array.isArray(file)) return [];
          const item = file as Record<string, unknown>;
          const path = stringValue(item.path);
          return path ? [{ path, sizeBytes: nullableNumberValue(item.size_bytes) }] : [];
        })
      : [];
    return [
      {
        folderId,
        originalPath,
        archivePath,
        fileCount: numberValue(record.file_count) ?? files.length,
        sizeBytes: nullableNumberValue(record.size_bytes),
        files,
      },
    ];
  });
}

function localDuplicateFolders(payload: Record<string, unknown>): LocalDuplicateFolder[] {
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  return folders.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const relPath = stringValue(record.rel_path);
    if (!relPath) return [];
    return [
      {
        relPath,
        files: numberValue(record.files) ?? 0,
        audioFiles: numberValue(record.audio_files) ?? 0,
        sizeBytes: nullableNumberValue(record.size_bytes),
      },
    ];
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
  if (
    /^(is|has|can)[A-Z_]/.test(field) ||
    /enabled|overwrite|dryRun|force|include|mark|delete|clear|check/i.test(field)
  ) {
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
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
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

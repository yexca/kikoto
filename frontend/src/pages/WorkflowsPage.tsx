import {
  Activity,
  AlertCircle,
  CalendarClock,
  Edit3,
  Eye,
  ExternalLink,
  GitBranchPlus,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Tag,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Input, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useWorkflowActivityLocation } from "@/features/workflows/useWorkflowActivityLocation";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useAuth } from "@/auth/AuthProvider";
import { openWorkDetail } from "@/app/workDetailNavigation";
import { WorkflowActivity } from "@/features/workflows/WorkflowActivity";
import {
  WorkflowRunSlotContent,
  WorkflowRunSlotProvider,
  WorkflowRunSlotTarget,
} from "@/features/workflows/WorkflowRunSlot";
import { RunDiagnostics } from "@/features/workflows/RunDiagnostics";
import { RunFacts, RunStatusBadge, RunSteps } from "@/features/workflows/RunOverview";
import { RunTransferProgress } from "@/features/workflows/RunTransferProgress";
import { formatBytes, isActiveRunStatus } from "@/features/workflows/runPresentation";
import {
  RecentRunList,
  RelativeTime,
  WorkflowHeader,
  WorkflowSection,
} from "@/features/workflows/WorkflowDetailLayout";
import { WorkflowNavigation, builtInWorkflowOrder } from "@/features/workflows/WorkflowNavigation";
import {
  presetBlockers,
  presetDefaultValues,
  presetInputsNeedReconfiguration,
  presetInputsPayload,
  presetMetadataEnabled,
  presetOptionalEnabled,
  presetOptionalFlagKey,
  presetReleaseRange,
  presetRunsUnfiltered,
  presetSourceCheckEnabled,
  presetSourceIds,
  PRESET_PERSON_NAME_KEY,
  presetTagEnabled,
  presetTargetValue,
  presetValuesFromInputs,
  presetVisibleParameters,
  PRESET_GROUPS,
  PRESET_OPTIONAL_FILTERS,
  PRESET_RELEASE_KEYS,
  PRESET_TAG_ENABLED_KEY,
  type PresetBlocker,
  type PresetFormValues,
} from "@/features/workflows/presetWorkflowModel";
import { parseWorkCodes, WorkCodesField } from "@/features/workflows/WorkCodesField";
import {
  OptionField,
  RunBlockerNote,
  RunOptionRows,
  SegmentedControl,
  SwitchControl,
  WorkflowRunButton,
  type RunFormLayout,
} from "@/features/workflows/RunOptionControls";
import { WorkflowRunMonitor } from "@/features/workflows/WorkflowRunMonitor";
import {
  RemoteSourceCheckboxes,
  VoiceActorPicker,
  useCompatibleRemoteSources,
} from "@/features/workflows/CreatorPresetFields";
import {
  METADATA_SYNC_MODES,
  METADATA_SYNC_SCOPES,
  metadataSyncBlockers,
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncValuesFromConfig,
  type MetadataSyncBlocker,
  type MetadataSyncFormValues,
} from "@/features/workflows/metadataSyncModel";
import { clearWorkflowRunPrefill, readWorkflowRunPrefill } from "@/features/workflows/workflowLinks";
import { workflowStages } from "@/features/workflows/workflowStageModel";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import {
  api,
  type AvailabilityWatch,
  type MetadataSyncOptions,
  type LibrarySource,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowDefinition,
  type WorkflowNodeRun,
  type WorkflowPreset,
  type WorkflowPresetParameter,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowTrigger,
} from "@/lib/api";
import { currentScopedStorageKey } from "@/lib/clientStorageScope";
import { openMetadataIssues } from "@/lib/metadataMaintenance";
import i18n from "@/i18n";

const workflowCopy = (key: string, options?: Record<string, unknown>) => i18n.t(`workflowPage.${key}`, options);

function localizedWorkflowDefinition(definition: WorkflowDefinition) {
  if (definition.scope !== "system") return definition;
  const key = `workflowPage.builtInDefinitions.${definition.code}`;
  return {
    ...definition,
    displayName: i18n.exists(`${key}.name`) ? i18n.t(`${key}.name`) : definition.displayName,
    description: i18n.exists(`${key}.description`) ? i18n.t(`${key}.description`) : definition.description,
  };
}

type ModalMode = "create-trigger" | "edit-trigger" | null;
type AutomationTriggerType = "startup" | "filesystem_event" | "schedule";
type CreatableAutomationTriggerType = Exclude<AutomationTriggerType, "filesystem_event">;

type WorkflowNode = {
  id: string;
  type: string;
  displayName?: string;
  config?: Record<string, unknown>;
};

const automationTriggerTypes: CreatableAutomationTriggerType[] = ["startup", "schedule"];
const workflowDefinitionStorageBaseKey = "kikoto.workflows.definition:v3";

type SystemRunKind = "local_scan" | "metadata_sync" | "remote_popular" | "dlsite_popular" | "preset";

type SystemRunOptions = {
  followUpRun?: boolean;
  metadataSync?: MetadataSyncOptions;
};

type DLsitePopularPeriod = "day" | "week" | "month" | "year";
type LocalScanMode = "incremental" | "full";

type DLsitePopularRunOptions = {
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
  skipTag: boolean;
};

type RemotePopularRunOptions = {
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  tagNameTemplate: string;
  skipTag: boolean;
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
  scanMode: LocalScanMode;
  sourceId: number;
  action: "track" | "fetch";
  limit: number;
  period: DLsitePopularPeriod;
  releaseWindow: "30d" | "";
  year: number;
  tagNameTemplate: string;
  skipTag: boolean;
};

type CurrentTriggerRunOptions = {
  code: string;
  systemConfig?: SystemWorkflowTriggerConfig;
  presetValues?: PresetFormValues;
  metadataSync?: MetadataSyncFormValues;
};

const manuallyRunnableSystemWorkflows: Record<string, SystemRunKind[]> = {
  availability_watch: [],
  local_library_scan: ["local_scan"],
  metadata_sync: ["metadata_sync"],
  remote_popular_collection: ["remote_popular"],
  dlsite_popular_collection: ["dlsite_popular"],
};

const configurableSystemWorkflowCodes = new Set(Object.keys(manuallyRunnableSystemWorkflows));

export function WorkflowsPage({
  canRun,
  canSyncMetadata,
  canTagWorks,
  canManageDownloads,
  readOnly = false,
}: {
  canRun: boolean;
  canSyncMetadata: boolean;
  canTagWorks: boolean;
  canManageDownloads: boolean;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const auth = useAuth();
  const workflowDefinitionStorageKey = currentScopedStorageKey(workflowDefinitionStorageBaseKey, auth.user?.id ?? null);
  const activityLocation = useWorkflowActivityLocation();
  const activityRun = useWorkflowRunWatcher(activityLocation.open ? activityLocation.runId : null);
  const linkedRun = activityRun.run?.id === activityLocation.runId ? activityRun.run : null;
  const linkedCode = linkedRun?.workflowCode || activityLocation.workflowCode || "";
  const [activityRevision, setActivityRevision] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionID] = useState<number | null>(() =>
    storedPositiveInt(workflowDefinitionStorageKey),
  );
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingTrigger, setEditingTrigger] = useState<WorkflowTrigger | null>(null);
  const [creatingTriggerType, setCreatingTriggerType] = useState<CreatableAutomationTriggerType>("schedule");
  const triggerAnchorRef = useRef<HTMLElement | null>(null);
  const [currentTriggerRunOptions, setCurrentTriggerRunOptions] = useState<CurrentTriggerRunOptions | null>(null);
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);
  const [runningSystemAction, setRunningSystemAction] = useState<SystemRunKind | null>(null);
  const [isWorkflowMetaLoading, setIsWorkflowMetaLoading] = useState(true);
  const [hasWorkflowMetaSnapshot, setHasWorkflowMetaSnapshot] = useState(false);
  const [workflowMetaError, setWorkflowMetaError] = useState("");
  const [remoteSourceAvailability, setRemoteSourceAvailability] = useState<"loading" | "available" | "unavailable">(
    "loading",
  );
  const [recentDefinitionRuns, setRecentDefinitionRuns] = useState<WorkflowRun[]>([]);
  const workflowMetaRequestSeq = useRef(0);
  const recentRunsRequestSeq = useRef(0);

  const refresh = () => {
    const seq = ++workflowMetaRequestSeq.current;
    setIsWorkflowMetaLoading(true);
    setWorkflowMetaError("");
    Promise.all([api.listWorkflowDefinitions(), api.listWorkflowTriggers(), api.listWorkflowPresets()])
      .then(([nextDefinitions, nextTriggers, nextPresets]) => {
        if (seq !== workflowMetaRequestSeq.current) return;
        setDefinitions(nextDefinitions);
        setTriggers(nextTriggers);
        setPresets(nextPresets);
        setHasWorkflowMetaSnapshot(true);
      })
      .catch(() => {
        if (seq === workflowMetaRequestSeq.current) setWorkflowMetaError(workflowCopy("metadataLoadFailed"));
      })
      .finally(() => {
        if (seq === workflowMetaRequestSeq.current) setIsWorkflowMetaLoading(false);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    let active = true;
    api
      .listLibrarySources()
      .then((sources) => {
        if (!active) return;
        setRemoteSourceAvailability(
          sources.some(
            (source) =>
              source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
          )
            ? "available"
            : "unavailable",
        );
      })
      .catch(() => {
        if (active) setRemoteSourceAvailability("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (linkedRun && linkedRun.workflowCode !== activityLocation.workflowCode) {
      activityLocation.resolveWorkflow(linkedRun.workflowCode);
    }
  }, [linkedRun?.id, linkedRun?.workflowCode, activityLocation.workflowCode]);

  const presetByCode = useMemo(() => new Map(presets.map((preset) => [preset.code, preset])), [presets]);
  const visibleDefinitions = useMemo(() => {
    const choices = [...definitions];
    if (linkedCode && !choices.some((definition) => definition.code === linkedCode)) {
      choices.push({
        id: -(linkedRun?.definitionId ?? linkedRun?.id ?? 1),
        code: linkedCode,
        displayName: linkedRun?.displayName ?? linkedCode,
        description: "",
        definitionJson: "{}",
        scope: "system",
        editable: false,
        ownerUserId: null,
        triggerCount: 0,
        createdAt: linkedRun?.createdAt ?? "",
        updatedAt: linkedRun?.createdAt ?? "",
      });
    }
    const builtInRank = (definition: WorkflowDefinition) =>
      builtInWorkflowOrder.includes(definition.code) ? builtInWorkflowOrder.indexOf(definition.code) : 99;
    return choices
      .filter(
        (definition) =>
          configurableSystemWorkflowCodes.has(definition.code) ||
          presetByCode.has(definition.code) ||
          definition.code === linkedCode,
      )
      .sort((left, right) => builtInRank(left) - builtInRank(right) || left.id - right.id);
  }, [definitions, linkedCode, linkedRun, presetByCode]);
  const selectedDefinition = useMemo(() => {
    return (
      visibleDefinitions.find((definition) => definition.code === linkedCode) ??
      visibleDefinitions.find((definition) => definition.id === selectedDefinitionId) ??
      visibleDefinitions[0] ??
      null
    );
  }, [linkedCode, selectedDefinitionId, visibleDefinitions]);

  useEffect(() => {
    if (!linkedCode) return;
    const linked = visibleDefinitions.find((definition) => definition.code === linkedCode);
    if (!linked) return;
    setSelectedDefinitionID(linked.id);
    storePositiveInt(workflowDefinitionStorageKey, linked.id);
  }, [linkedCode, visibleDefinitions, workflowDefinitionStorageKey]);

  const refreshRecentRuns = (workflowCode: string) => {
    if (!workflowCode) {
      setRecentDefinitionRuns([]);
      return Promise.resolve();
    }
    const seq = ++recentRunsRequestSeq.current;
    return api
      .listWorkflowRuns(1, 5, "", "", workflowCode)
      .then((page) => {
        if (seq === recentRunsRequestSeq.current) setRecentDefinitionRuns(page.runs);
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!selectedDefinition) {
      setRecentDefinitionRuns([]);
      return;
    }
    setRecentDefinitionRuns([]);
    void refreshRecentRuns(selectedDefinition.code);
    return () => {
      recentRunsRequestSeq.current += 1;
    };
  }, [selectedDefinition?.code]);

  const hasActiveRecentRun = recentDefinitionRuns.some((run) => run.status === "queued" || run.status === "running");
  useEffect(() => {
    if (!selectedDefinition || !hasActiveRecentRun) return;
    const timer = window.setInterval(() => void refreshRecentRuns(selectedDefinition.code), 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveRecentRun, selectedDefinition?.code]);

  const selectedPreset = selectedDefinition ? (presetByCode.get(selectedDefinition.code) ?? null) : null;
  const selectedSystemRunKinds = selectedDefinition
    ? selectedPreset
      ? (["preset"] as SystemRunKind[])
      : manuallyRunnableSystemWorkflows[selectedDefinition.code]
    : undefined;
  const definitionEmptyText = workflowCopy("definitionEmpty");

  useEffect(() => {
    if (isWorkflowMetaLoading) return;
    const linkedCode = new URLSearchParams(window.location.search).get("workflow")?.trim();
    const linkedDefinition = linkedCode
      ? visibleDefinitions.find((definition) => definition.code === linkedCode)
      : undefined;
    const nextID = linkedDefinition?.id ?? selectedDefinition?.id ?? null;
    if (selectedDefinitionId !== nextID) {
      setSelectedDefinitionID(nextID);
    }
    storePositiveInt(workflowDefinitionStorageKey, nextID);
  }, [
    isWorkflowMetaLoading,
    selectedDefinition?.id,
    selectedDefinitionId,
    visibleDefinitions,
    workflowDefinitionStorageKey,
  ]);

  const selectDefinition = (definition: WorkflowDefinition) => {
    setSelectedDefinitionID(definition.id);
    storePositiveInt(workflowDefinitionStorageKey, definition.id);
    activityLocation.selectWorkflow(definition.code);
  };

  // Activity replaces a success toast: the new run is visible there with the rest of the queue.
  const showQueuedRun = () => {
    setActivityRevision((value) => value + 1);
    activityLocation.openList();
  };

  const runLocalScan = async (followUpRun = false) => {
    setIsRunningScan(true);
    try {
      await api.runLocalScan({ followUpRun });
      void refreshRecentRuns("local_library_scan");
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("localScanCreateFailed")));
    } finally {
      setIsRunningScan(false);
    }
  };

  const runMetadataSync = async (options?: MetadataSyncOptions) => {
    setIsSyncingMetadata(true);
    try {
      await api.runDLsiteSync(options);
      void refreshRecentRuns("metadata_sync");
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("metadataSyncCreateFailed")));
    } finally {
      setIsSyncingMetadata(false);
    }
  };

  const runPopularCollection = async (options: RemotePopularRunOptions) => {
    setRunningSystemAction("remote_popular");
    try {
      await api.runRemotePopularCollection(options);
      refresh();
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("remotePopularQueueFailed")));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runDLsitePopularCollection = async (options: DLsitePopularRunOptions) => {
    setRunningSystemAction("dlsite_popular");
    try {
      await api.runDLsitePopularCollection(options);
      refresh();
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("dlsitePopularQueueFailed")));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runPreset = async (inputs: Record<string, unknown>) => {
    if (!selectedPreset || !selectedDefinition) return;
    setRunningSystemAction("preset");
    try {
      await api.runWorkflowPreset(selectedPreset.code, inputs);
      void refreshRecentRuns(selectedDefinition.code);
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("presetQueueFailed")));
    } finally {
      setRunningSystemAction(null);
    }
  };

  const runSystemAction = async (kind: SystemRunKind, options: SystemRunOptions = {}) => {
    if (kind === "local_scan") return runLocalScan(options.followUpRun ?? false);
    if (kind === "metadata_sync") return runMetadataSync(options.metadataSync);
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
    if (kind === "remote_popular") return canRun && canTagWorks && remoteSourceAvailability !== "unavailable";
    // Follow runs refresh catalogs and sync metadata; the optional tag checks tags:write itself.
    if (kind === "preset") return canRun && canSyncMetadata;
    return canRun;
  };

  const createAutomationTrigger = (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => {
    setCreatingTriggerType(triggerType);
    setEditingTrigger(null);
    triggerAnchorRef.current = anchor ?? null;
    setModalMode("create-trigger");
  };

  const editAutomationTrigger = (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => {
    setEditingTrigger(trigger);
    triggerAnchorRef.current = anchor ?? null;
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
      toast.notify(
        toastFromError(
          error,
          workflowCopy("triggerUpdateFailed", { action: enabled ? workflowCopy("enable") : workflowCopy("pause") }),
        ),
      );
    }
  };

  const refreshSelectedRunReview = async () => {
    await activityRun.refresh(true);
    setActivityRevision((value) => value + 1);
    if (selectedDefinition) await refreshRecentRuns(selectedDefinition.code);
  };
  const openActivityRun = (run: WorkflowRun) => activityLocation.openRun(run.id, run.workflowCode);

  return (
    <div className="space-y-4">
      {readOnly && <DemoReadOnlyNotice />}
      {hasWorkflowMetaSnapshot && workflowMetaError && (
        <div
          className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2"
          role="alert"
        >
          <span className="text-sm text-error-foreground">
            {workflowMetaError} {t("workflow.existingDataShown")}
          </span>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      <WorkflowRunSlotProvider>
        <div className="min-w-0 space-y-4">
          <WorkflowNavigation
            actions={
              <>
                <WorkflowRunSlotTarget />
                <WorkflowActivity
                  key="global-activity"
                  workflowCode="all"
                  workflowName=""
                  open={activityLocation.open}
                  onOpenChange={activityLocation.setOpen}
                  selectedRunId={activityLocation.runId}
                  onSelectRun={openActivityRun}
                  onBack={activityLocation.backToList}
                  refreshKey={activityRevision}
                  readOnly={readOnly}
                  canSyncMetadata={canSyncMetadata}
                  detail={
                    activityLocation.runId ? (
                      <>
                        {activityRun.error && (
                          <div role="alert" className="rounded-md border p-3 text-sm">
                            {workflowCopy("activityLoadFailed")}{" "}
                            <Button variant="outline" onClick={() => void activityRun.refresh(true)}>
                              {t("common.retry")}
                            </Button>
                          </div>
                        )}
                        <RunDetail
                          key={activityLocation.runId}
                          run={linkedRun}
                          candidates={linkedRun ? activityRun.candidates : []}
                          events={linkedRun ? activityRun.events : []}
                          loading={!linkedRun && !activityRun.error}
                          onCandidateUpdate={refreshSelectedRunReview}
                          onRunAction={refreshSelectedRunReview}
                          canSyncMetadata={canSyncMetadata}
                          readOnly={readOnly}
                        />
                      </>
                    ) : undefined
                  }
                />
              </>
            }
            definitions={visibleDefinitions}
            selectedId={selectedDefinition?.id ?? null}
            onSelect={selectDefinition}
          />
          <div
            id="workflow-definition-panel"
            role="tabpanel"
            aria-labelledby={selectedDefinition ? `workflow-tab-${selectedDefinition.id}` : undefined}
            tabIndex={0}
          >
            {!hasWorkflowMetaSnapshot && isWorkflowMetaLoading ? (
              <WorkflowMetadataLoadingState />
            ) : !hasWorkflowMetaSnapshot && workflowMetaError ? (
              <WorkflowMetadataErrorState message={workflowMetaError} onRetry={refresh} />
            ) : selectedDefinition?.code === "availability_watch" ? (
              <AvailabilityWatchPanel
                definition={selectedDefinition}
                triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === selectedDefinition.id)}
                recentRuns={recentDefinitionRuns}
                readOnly={readOnly}
                canManageDownloads={canManageDownloads}
                onCreateTrigger={createAutomationTrigger}
                onEditTrigger={editAutomationTrigger}
                onToggleTrigger={toggleAutomationTrigger}
                onOpenRun={openActivityRun}
                onRunQueued={() => {
                  void refreshRecentRuns("availability_watch");
                  showQueuedRun();
                }}
              />
            ) : (
              <WorkflowDetail
                definition={selectedDefinition}
                definitionTriggers={triggers.filter(
                  (trigger) => trigger.workflowDefinitionId === selectedDefinition?.id,
                )}
                canManageTriggers={!readOnly && (selectedDefinition?.id ?? 0) > 0}
                readOnly={readOnly}
                systemRunKinds={selectedSystemRunKinds}
                isSystemActionRunning={systemActionBusy}
                canRunSystemAction={systemActionAllowed}
                onRunSystemAction={runSystemAction}
                onRunRemotePopular={runPopularCollection}
                canFetchRemotePopular={canManageDownloads}
                canTag={canTagWorks}
                remoteSourceUnavailable={remoteSourceAvailability === "unavailable"}
                onOpenRemoteSourceSettings={openRemoteSourcesSettings}
                onRunDLsitePopular={runDLsitePopularCollection}
                preset={selectedPreset}
                onRunPreset={runPreset}
                onTriggerRunOptionsChange={setCurrentTriggerRunOptions}
                recentRuns={recentDefinitionRuns}
                onOpenRun={openActivityRun}
                onCreateTrigger={createAutomationTrigger}
                onEditTrigger={editAutomationTrigger}
                onToggleTrigger={toggleAutomationTrigger}
                emptyText={definitionEmptyText}
              />
            )}
          </div>
        </div>
      </WorkflowRunSlotProvider>

      {modalMode === "create-trigger" && selectedDefinition && (
        <TriggerModal
          definition={selectedDefinition}
          preset={selectedPreset}
          canTag={canTagWorks}
          trigger={null}
          initialTriggerType={creatingTriggerType}
          currentRunOptions={
            currentTriggerRunOptions?.code === selectedDefinition.code ? currentTriggerRunOptions : null
          }
          anchorRef={triggerAnchorRef}
          onClose={() => {
            triggerAnchorRef.current = null;
            setModalMode(null);
          }}
          onSaved={() => {
            triggerAnchorRef.current = null;
            setModalMode(null);
            refresh();
          }}
          onDeleted={() => undefined}
        />
      )}
      {modalMode === "edit-trigger" && selectedDefinition && editingTrigger && (
        <TriggerModal
          definition={selectedDefinition}
          preset={selectedPreset}
          canTag={canTagWorks}
          trigger={editingTrigger}
          readOnly={readOnly}
          initialTriggerType={editingTrigger.triggerType === "startup" ? "startup" : "schedule"}
          currentRunOptions={
            currentTriggerRunOptions?.code === selectedDefinition.code ? currentTriggerRunOptions : null
          }
          anchorRef={triggerAnchorRef}
          onClose={() => {
            triggerAnchorRef.current = null;
            setModalMode(null);
          }}
          onSaved={() => {
            triggerAnchorRef.current = null;
            setModalMode(null);
            refresh();
          }}
          onDeleted={() => {
            triggerAnchorRef.current = null;
            setEditingTrigger(null);
            setModalMode(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

type AvailabilityWatchDialog = "monitoring" | "ready" | null;

function AvailabilityWatchPanel({
  definition,
  triggers,
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
  recentRuns: WorkflowRun[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEditTrigger: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
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
        if (!cancelled)
          setLoadError(error instanceof Error ? error.message : workflowCopy("availabilityWatchLoadFailed"));
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
    return (
      <WorkflowMetadataErrorState
        message={loadError || workflowCopy("availabilityWatchLoadFailed")}
        onRetry={() => void refreshWatch()}
      />
    );
  }

  const monitoring = watch.targets.filter((target) => target.state === "monitoring" || target.state === "error");
  const ready = watch.targets.filter(
    (target) => target.state !== "monitoring" && target.state !== "error" && target.state !== "disabled",
  );
  const nodes = parseNodes(definition.definitionJson);
  const displayDefinition = localizedWorkflowDefinition(definition);

  const layout = runFormLayout({
    title: displayDefinition.displayName,
    description: displayDefinition.description,
    optionsTitle: workflowCopy("configuration"),
  });

  return (
    <Card className="min-w-0">
      <CardContent className="min-w-0 space-y-5 p-5">
        <AvailabilityWatchRunForm
          layout={layout}
          watch={watch}
          sources={sources}
          readOnly={readOnly}
          canManageDownloads={canManageDownloads}
          onSaved={setWatch}
          onRunQueued={onRunQueued}
        />

        <section className="grid rounded-lg bg-muted/35 sm:grid-cols-2" aria-label={workflowCopy("availabilityPools")}>
          <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{workflowCopy("monitoring")}</div>
              <div className="mt-1 text-2xl font-semibold">{monitoring.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDialog("monitoring")}>
              <Edit3 className="h-4 w-4" />
              {workflowCopy("editNode")}
            </Button>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3 border-t px-4 py-3.5 sm:border-l sm:border-t-0">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{workflowCopy("ready")}</div>
              <div className="mt-1 text-2xl font-semibold">{ready.length}</div>
            </div>
            <Button size="sm" variant="outline" onClick={openReady}>
              <Eye className="h-4 w-4" />
              {workflowCopy("view")}
            </Button>
          </div>
        </section>

        <DefinitionRunMonitor nodes={nodes} recentRuns={recentRuns} onOpenRun={onOpenRun} />
        <div className="grid min-w-0 gap-x-10 gap-y-5 lg:grid-cols-2">
          <WorkflowAutomationPanel
            definition={definition}
            triggers={triggers}
            canManage={!readOnly}
            readOnly={readOnly}
            onCreate={onCreateTrigger}
            onEdit={onEditTrigger}
            onToggle={onToggleTrigger}
          />
          <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />
        </div>
      </CardContent>

      {dialog === "monitoring" && (
        <AvailabilityWatchMonitoringDialog watch={watch} readOnly={readOnly} onClose={closeDialog} onSaved={setWatch} />
      )}
      {dialog === "ready" && (
        <AvailabilityWatchReadyDialog
          targets={ready}
          readOnly={readOnly}
          onClose={closeDialog}
          onChanged={() =>
            void refreshWatch().catch((error) =>
              toast.notify(toastFromError(error, workflowCopy("readyPoolRefreshFailed"))),
            )
          }
        />
      )}
    </Card>
  );
}

function availabilityWatchExtensions(value: string) {
  return value
    .split(/[\s,;，；]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function availabilityWatchActionOptions(canManageDownloads: boolean) {
  return [
    { value: "monitor" as const, label: workflowCopy("monitorOnly") },
    { value: "track" as const, label: workflowCopy("track") },
    { value: "fetch" as const, label: workflowCopy("fetch"), disabled: !canManageDownloads },
    { value: "track_fetch" as const, label: workflowCopy("trackFetch"), disabled: !canManageDownloads },
  ];
}

/**
 * Availability Watch keeps a saved configuration, so its header offers
 * Configure beside Run and the section below summarizes what Run will use.
 */
function AvailabilityWatchRunForm({
  layout,
  watch,
  sources,
  readOnly,
  canManageDownloads,
  onSaved,
  onRunQueued,
}: {
  layout: RunFormLayout;
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onSaved: (watch: AvailabilityWatch) => void;
  onRunQueued: () => void;
}) {
  const toast = useToast();
  const configureRef = useRef<HTMLButtonElement | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [running, setRunning] = useState(false);
  const sourceName = watch.sourceId
    ? (sources.find((source) => source.id === watch.sourceId)?.displayName ?? `#${watch.sourceId}`)
    : workflowCopy("anyHealthySource");
  const actionName =
    availabilityWatchActionOptions(true).find((option) => option.value === watch.action)?.label ?? watch.action;

  const run = async () => {
    setRunning(true);
    try {
      await api.runAvailabilityWatch();
      onRunQueued();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("availabilityWatchRunFailed")));
    } finally {
      setRunning(false);
    }
  };

  const summary: [string, string][] = [
    [workflowCopy("remoteSource"), sourceName],
    [workflowCopy("whenAvailable"), actionName],
    [
      workflowCopy("excludeExtensions"),
      watch.excludeExtensions.length > 0 ? watch.excludeExtensions.join(", ") : workflowCopy("noExcludedExtensions"),
    ],
  ];

  return (
    <>
      {layout({
        run: <WorkflowRunButton running={running} disabled={readOnly} onClick={() => void run()} />,
        actions: (
          <Button
            ref={configureRef}
            variant="outline"
            aria-expanded={configuring}
            onClick={() => setConfiguring((open) => !open)}
          >
            <Settings2 className="h-4 w-4" />
            {workflowCopy("configure")}
          </Button>
        ),
        options: (
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
            {summary.map(([term, detail]) => (
              <div key={term} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{term}</dt>
                <dd className="mt-1 truncate text-sm font-medium" title={detail}>
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        ),
      })}
      {configuring && (
        <AvailabilityWatchConfigurePopover
          anchorRef={configureRef}
          watch={watch}
          sources={sources}
          readOnly={readOnly}
          canManageDownloads={canManageDownloads}
          onClose={() => setConfiguring(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

function AvailabilityWatchConfigurePopover({
  anchorRef,
  watch,
  sources,
  readOnly,
  canManageDownloads,
  onClose,
  onSaved,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  watch: AvailabilityWatch;
  sources: LibrarySource[];
  readOnly: boolean;
  canManageDownloads: boolean;
  onClose: () => void;
  onSaved: (watch: AvailabilityWatch) => void;
}) {
  const toast = useToast();
  const [action, setAction] = useState<AvailabilityWatch["action"]>(watch.action);
  const [sourceId, setSourceId] = useState(watch.sourceId ?? 0);
  const [excludeEnabled, setExcludeEnabled] = useState(watch.excludeExtensions.length > 0);
  const [excluded, setExcluded] = useState(watch.excludeExtensions.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const disabled = readOnly || saving;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = await api.updateAvailabilityWatch({
        action,
        sourceId: sourceId || null,
        excludeExtensions: excludeEnabled ? availabilityWatchExtensions(excluded) : [],
      });
      onSaved(saved);
      toast.success(workflowCopy("availabilityWatchSaved"));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : workflowCopy("availabilityWatchSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnchoredPopover
      open
      anchorRef={anchorRef}
      onOpenChange={(open) => !open && onClose()}
      ariaLabel={workflowCopy("configuration")}
      className="w-[min(28rem,calc(100vw-1.5rem))] p-4"
    >
      <div className="grid gap-4">
        <h4 className="text-sm font-semibold">{workflowCopy("configuration")}</h4>
        <OptionField label={workflowCopy("remoteSource")} htmlFor="availability-watch-source" stacked>
          <NativeSelect
            id="availability-watch-source"
            fieldSize="sm"
            value={sourceId}
            onChange={(event) => setSourceId(Number(event.target.value))}
            disabled={disabled}
          >
            <option value={0}>{workflowCopy("anyHealthySource")}</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </OptionField>
        <OptionField label={workflowCopy("whenAvailable")} stacked>
          <SegmentedControl
            label={workflowCopy("whenAvailable")}
            value={action}
            onChange={setAction}
            disabled={disabled}
            options={availabilityWatchActionOptions(canManageDownloads)}
          />
        </OptionField>
        <OptionField label={workflowCopy("excludeExtensions")} stacked>
          <SwitchControl
            label={workflowCopy("excludeExtensions")}
            description={workflowCopy("excludeExtensionsDescription")}
            checked={excludeEnabled}
            onCheckedChange={setExcludeEnabled}
            disabled={disabled}
          />
          {excludeEnabled && (
            <Input
              fieldSize="sm"
              aria-label={workflowCopy("extensionsToExclude")}
              value={excluded}
              onChange={(event) => setExcluded(event.target.value)}
              placeholder={workflowCopy("extensionsPlaceholder")}
              disabled={disabled}
            />
          )}
        </OptionField>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {workflowCopy("cancel")}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={disabled}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {workflowCopy("save")}
          </Button>
        </div>
      </div>
    </AnchoredPopover>
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
      toast.success(workflowCopy("monitoringPoolUpdated"));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : workflowCopy("monitoringPoolSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={workflowCopy("editMonitoringPool")} onClose={onClose}>
      <div className="space-y-4">
        <Field label={workflowCopy("works")}>
          <WorkCodesField value={codes} onChange={setCodes} readOnly={readOnly} ariaLabel={workflowCopy("works")} />
        </Field>
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={readOnly || saving || parsed.invalid.length > 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {workflowCopy("save")}
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
        returnLabel: workflowCopy("backToAvailabilityWatch"),
      },
    );
  };
  const track = async (target: AvailabilityWatch["targets"][number]) => {
    setBusy({ id: target.id, action: "track" });
    try {
      const result = await api.trackAvailabilityWatchTarget(target.id);
      toast.success(workflowCopy("trackRunQueued", { runId: result.runId }));
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("trackTargetFailed", { workCode: target.workCode })));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (target: AvailabilityWatch["targets"][number]) => {
    setBusy({ id: target.id, action: "remove" });
    try {
      await api.removeAvailabilityWatchTarget(target.id);
      toast.success(workflowCopy("removedFromWatch", { workCode: target.workCode }));
      onChanged();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("removeTargetFailed", { workCode: target.workCode })));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={workflowCopy("readyWorks", { count: targets.length })} onClose={onClose}>
      <div className="divide-y rounded-md border">
        {targets.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{workflowCopy("noAvailableWorks")}</div>
        ) : (
          targets.map((target) => {
            const targetBusy = busy?.id === target.id;
            return (
              <div key={target.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm font-semibold">{target.workCode}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant={target.lastError ? "warning" : "secondary"}>
                      {target.state === "completed" ? workflowCopy("dispatched") : target.state.replace("_", " ")}
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
                    {workflowCopy("open")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void track(target)}
                    disabled={readOnly || targetBusy}
                  >
                    {targetBusy && busy?.action === "track" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <GitBranchPlus className="h-4 w-4" />
                    )}
                    {workflowCopy("track")}
                  </Button>
                  {(target.fetchRunId || target.trackRunId) && (
                    <Button
                      size="icon"
                      variant="ghost"
                      title={workflowCopy("openRelatedActivity")}
                      aria-label={workflowCopy("openActivityFor", { workCode: target.workCode })}
                      onClick={() => openActivityRunID(target.fetchRunId ?? target.trackRunId!)}
                    >
                      <Activity className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    title={workflowCopy("removeFromWatch")}
                    aria-label={workflowCopy("removeFromWatchAria", { workCode: target.workCode })}
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
  window.history.pushState({}, "", `/workflows?activity=1&run=${runID}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function WorkflowMetadataLoadingState() {
  return (
    <Card className="min-h-72" role="status" aria-label={workflowCopy("loadingWorkflowData")} aria-busy="true">
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
    <Card className="min-h-72 border-error-border" role="alert">
      <CardContent className="grid min-h-72 place-items-center p-6 text-center">
        <div>
          <p className="text-sm text-error-foreground">{message}</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}>
            {workflowCopy("retry")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkflowDetail({
  definition,
  definitionTriggers = [],
  canManageTriggers,
  readOnly = false,
  systemRunKinds,
  isSystemActionRunning,
  canRunSystemAction,
  onRunSystemAction,
  onRunRemotePopular,
  onOpenRemoteSourceSettings,
  canFetchRemotePopular = false,
  canTag = false,
  remoteSourceUnavailable = false,
  onRunDLsitePopular,
  preset = null,
  onRunPreset,
  onTriggerRunOptionsChange,
  recentRuns = [],
  onOpenRun,
  emptyText = workflowCopy("selectWorkflowNodePipeline"),
  onCreateTrigger,
  onEditTrigger,
  onToggleTrigger,
}: {
  definition: WorkflowDefinition | null;
  definitionTriggers?: WorkflowTrigger[];
  canManageTriggers: boolean;
  /** Demo opens run forms and triggers for inspection; running and saving stay disabled. */
  readOnly?: boolean;
  systemRunKinds?: SystemRunKind[];
  isSystemActionRunning?: (kind: SystemRunKind) => boolean;
  canRunSystemAction?: (kind: SystemRunKind) => boolean;
  onRunSystemAction?: (kind: SystemRunKind, options?: SystemRunOptions) => Promise<void>;
  onRunRemotePopular?: (options: RemotePopularRunOptions) => Promise<void>;
  onOpenRemoteSourceSettings?: () => void;
  canFetchRemotePopular?: boolean;
  canTag?: boolean;
  remoteSourceUnavailable?: boolean;
  onRunDLsitePopular?: (options: DLsitePopularRunOptions) => Promise<void>;
  preset?: WorkflowPreset | null;
  onRunPreset?: (inputs: Record<string, unknown>) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
  recentRuns?: WorkflowRun[];
  onOpenRun?: (run: WorkflowRun) => void;
  emptyText?: string;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEditTrigger: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
  onToggleTrigger: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
}) {
  const definitionJson = definition?.definitionJson ?? "";
  const nodes = useMemo(() => parseNodes(definitionJson), [definitionJson]);
  if (!definition) {
    return <EmptyPanel text={emptyText} />;
  }
  const displayDefinition = localizedWorkflowDefinition(definition);
  const runKind = definition.scope === "system" ? systemRunKinds?.[0] : undefined;
  const running = runKind ? (isSystemActionRunning?.(runKind) ?? false) : false;
  const allowed = runKind ? (canRunSystemAction?.(runKind) ?? false) : false;
  const layout = runFormLayout({
    title: displayDefinition.displayName,
    description: displayDefinition.description || workflowCopy("noDescription"),
    optionsTitle: workflowCopy("runOptions"),
  });
  // Keyed by definition so switching workflows starts from that workflow's defaults.
  const runForm =
    runKind === "local_scan" && onRunSystemAction ? (
      <LocalScanRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        onRun={(followUpRun) => onRunSystemAction("local_scan", { followUpRun })}
      />
    ) : runKind === "dlsite_popular" && onRunDLsitePopular ? (
      <DLsitePopularRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        onRun={onRunDLsitePopular}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : runKind === "remote_popular" && onRunRemotePopular ? (
      <RemotePopularRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        canFetch={canFetchRemotePopular}
        onRun={onRunRemotePopular}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : runKind === "preset" && preset && onRunPreset ? (
      <PresetRunPanel
        key={definition.code}
        layout={layout}
        preset={preset}
        running={running}
        allowed={allowed}
        canTag={canTag}
        onRun={onRunPreset}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : runKind === "metadata_sync" && onRunSystemAction ? (
      <MetadataSyncRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        onRun={(metadataSync) => onRunSystemAction("metadata_sync", { metadataSync })}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : (
      layout({ run: null, options: null })
    );
  return (
    <Card className="relative min-w-0 overflow-hidden">
      <CardContent className="min-w-0 space-y-5 p-5">
        {runForm}

        <DefinitionRunMonitor nodes={nodes} recentRuns={recentRuns} onOpenRun={onOpenRun} />

        <div className="grid min-w-0 gap-x-10 gap-y-5 lg:grid-cols-2">
          {(supportedAutomationTriggerTypes(definition, Boolean(preset)).length > 0 ||
            definitionTriggers.length > 0) && (
            <WorkflowAutomationPanel
              definition={definition}
              isPreset={Boolean(preset)}
              triggers={definitionTriggers}
              canManage={canManageTriggers}
              readOnly={readOnly}
              onCreate={onCreateTrigger}
              onEdit={onEditTrigger}
              onToggle={onToggleTrigger}
            />
          )}
          {onOpenRun && <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />}
        </div>
      </CardContent>
      {definition.code === "remote_popular_collection" && remoteSourceUnavailable && (
        <div
          className="absolute inset-0 z-10 grid place-items-center bg-background/80 p-6 text-center backdrop-blur-sm"
          role="status"
        >
          <div className="max-w-sm space-y-3 rounded-lg border bg-card/95 p-6 shadow-lg">
            <AlertCircle className="mx-auto h-8 w-8 text-warning-foreground" />
            <div>
              <h4 className="font-semibold">{workflowCopy("remotePopularRequiresSource")}</h4>
              <p className="mt-1 text-sm text-muted-foreground">{workflowCopy("remotePopularSourceHint")}</p>
            </div>
            {onOpenRemoteSourceSettings && (
              <Button variant="outline" onClick={onOpenRemoteSourceSettings}>
                <Settings2 className="h-4 w-4" />
                {workflowCopy("configureRemoteSource")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function runFormLayout({
  title,
  description,
  optionsTitle,
}: {
  title: string;
  description?: string;
  optionsTitle: string;
}): RunFormLayout {
  return ({ run, actions, options, optionsActions }) => (
    <div className="space-y-5">
      {run && <WorkflowRunSlotContent>{run}</WorkflowRunSlotContent>}
      <WorkflowHeader title={title} description={description} actions={actions} />
      {options && (
        <section className="min-w-0 space-y-4 border-t pt-5" aria-label={optionsTitle}>
          <div className="flex min-h-8 items-center justify-between gap-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{optionsTitle}</h4>
            {optionsActions && <div className="-mr-2 flex gap-1">{optionsActions}</div>}
          </div>
          {options}
        </section>
      )}
    </div>
  );
}

function LocalScanRunPanel({
  layout,
  running,
  allowed,
  onRun,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (followUpRun: boolean) => Promise<void>;
}) {
  const [followUpRun, setFollowUpRun] = useState(false);
  return layout({
    run: <WorkflowRunButton running={running} disabled={!allowed} onClick={() => void onRun(followUpRun)} />,
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("followUpRun")}>
          <SwitchControl
            label={workflowCopy("followUpRun")}
            description={workflowCopy("followUpDescription")}
            checked={followUpRun}
            onCheckedChange={setFollowUpRun}
            disabled={running || !allowed}
          />
        </OptionField>
      </RunOptionRows>
    ),
  });
}

function metadataSyncBlockerText(blocker: MetadataSyncBlocker) {
  return blocker === "circle_required"
    ? workflowCopy("metadataSyncScope.circleRequired")
    : workflowCopy("metadataSyncScope.voiceRequired");
}

/** Metadata sync scope: which existing works to refresh, and how much of their metadata. */
function MetadataSyncFields({
  idPrefix,
  values,
  compact = false,
  disabled = false,
  onChange,
}: {
  idPrefix: string;
  values: MetadataSyncFormValues;
  compact?: boolean;
  disabled?: boolean;
  onChange: Dispatch<SetStateAction<MetadataSyncFormValues>>;
}) {
  const update = (next: Partial<MetadataSyncFormValues>) => onChange((current) => ({ ...current, ...next }));
  return (
    <RunOptionRows>
      <OptionField
        label={workflowCopy("metadataSyncScope.label")}
        hint={workflowCopy("metadataSyncScope.hint")}
        stacked={compact}
      >
        <SegmentedControl
          label={workflowCopy("metadataSyncScope.label")}
          value={values.scope}
          onChange={(scope) => update({ scope: scope as MetadataSyncFormValues["scope"] })}
          options={METADATA_SYNC_SCOPES.map((scope) => ({
            value: scope,
            label: workflowCopy(`metadataSyncScope.scopes.${scope}`),
            disabled,
          }))}
        />
      </OptionField>
      {values.scope === "circle" && (
        <OptionField label={presetParameterLabel("circleId")} htmlFor={`${idPrefix}-circle`} stacked={compact}>
          <Input
            id={`${idPrefix}-circle`}
            fieldSize="sm"
            className="max-w-48"
            value={values.circleId}
            placeholder={workflowCopy("metadataSyncScope.circlePlaceholder")}
            disabled={disabled}
            onChange={(event) => update({ circleId: event.target.value })}
          />
        </OptionField>
      )}
      {values.scope === "voice" && (
        <OptionField label={presetParameterLabel("personId")} htmlFor={`${idPrefix}-voice`} stacked={compact}>
          <VoiceActorPicker
            id={`${idPrefix}-voice`}
            personId={values.personId}
            displayName={values.personName}
            onChange={(personId, personName) => update({ personId, personName })}
          />
        </OptionField>
      )}
      <OptionField
        label={workflowCopy("metadataSyncScope.mode")}
        hint={
          values.mode === "full" && values.scope === "all"
            ? workflowCopy("metadataSyncScope.fullLibraryHint")
            : undefined
        }
        stacked={compact}
      >
        <SegmentedControl
          label={workflowCopy("metadataSyncScope.mode")}
          value={values.mode}
          onChange={(mode) => update({ mode: mode as MetadataSyncFormValues["mode"] })}
          options={METADATA_SYNC_MODES.map((mode) => ({
            value: mode,
            label: workflowCopy(`metadataSyncScope.modes.${mode}`),
            disabled,
          }))}
        />
      </OptionField>
    </RunOptionRows>
  );
}

function MetadataSyncRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: MetadataSyncOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [values, setValues] = useState<MetadataSyncFormValues>(metadataSyncDefaultValues);
  useEffect(() => {
    onTriggerRunOptionsChange?.({ code: "metadata_sync", metadataSync: values });
  }, [values, onTriggerRunOptionsChange]);
  const blockers = metadataSyncBlockers(values);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!allowed || blockers.length > 0}
        onClick={() => void onRun(metadataSyncPayload(values))}
      />
    ),
    options: (
      <div className="grid gap-5">
        <MetadataSyncFields idPrefix="metadata-sync-run" values={values} onChange={setValues} />
        {blockers.length > 0 && <RunBlockerNote>{metadataSyncBlockerText(blockers[0])}</RunBlockerNote>}
      </div>
    ),
  });
}

function RemotePopularRunPanel({
  layout,
  running,
  allowed,
  canFetch,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  canFetch: boolean;
  onRun: (options: RemotePopularRunOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceId, setSourceId] = useState(0);
  const [action, setAction] = useState<"track" | "fetch">("track");
  const [limit, setLimit] = useState(25);
  const [tagEnabled, setTagEnabled] = useState(true);
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

  const tagReady = !tagEnabled || (!tagError && tagPreview.value.length > 0);
  const canSubmit = allowed && sourceId > 0 && tagReady && (action !== "fetch" || canFetch);
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "remote_popular_collection",
      systemConfig: {
        ...workflowSystemTriggerConfig("remote_popular_collection", null),
        sourceId,
        action,
        limit,
        tagNameTemplate,
        skipTag: !tagEnabled,
      },
    });
  }, [sourceId, action, limit, tagNameTemplate, tagEnabled, onTriggerRunOptionsChange]);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!canSubmit}
        onClick={() =>
          void onRun({
            sourceId,
            action,
            limit,
            tagNameTemplate: tagEnabled ? tagNameTemplate.trim() : "",
            skipTag: !tagEnabled,
          })
        }
      />
    ),
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("remoteSource")} htmlFor="remote-popular-source">
          <NativeSelect
            id="remote-popular-source"
            fieldSize="sm"
            className="max-w-sm"
            value={sourceId}
            disabled={loadingSources || compatibleSources.length === 0}
            onChange={(event) => setSourceId(Number(event.target.value))}
          >
            {compatibleSources.length === 0 && (
              <option value={0}>
                {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
              </option>
            )}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </OptionField>
        <OptionField
          label={workflowCopy("action")}
          hint={action === "fetch" && !canFetch ? workflowCopy("fetchPermissionRequired") : undefined}
        >
          <SegmentedControl
            label={workflowCopy("remotePopularAction")}
            value={action}
            onChange={setAction}
            options={[
              { value: "track", label: workflowCopy("track") },
              { value: "fetch", label: workflowCopy("fetch") },
            ]}
          />
        </OptionField>
        <OptionField label={workflowCopy("workLimit")}>
          <SegmentedControl
            label={workflowCopy("workLimit")}
            value={String(limit)}
            onChange={(next) => setLimit(Number(next))}
            options={["10", "25", "50", "100"].map((item) => ({ value: item, label: item }))}
          />
        </OptionField>
        <TagTemplateField
          id="remote-popular-tag-template"
          row
          enabled={tagEnabled}
          onEnabledChange={setTagEnabled}
          value={tagNameTemplate}
          defaultValue={REMOTE_POPULAR_TAG_TEMPLATE}
          tokens={tagTokens}
          preview={tagPreview}
          error={tagError}
          onChange={setTagNameTemplate}
        />
      </RunOptionRows>
    ),
  });
}

function presetParameterLabel(key: string) {
  return workflowCopy(`presetParams.${key}`);
}

function presetOptionLabel(value: string) {
  return i18n.exists(`workflowPage.presetOptions.${value}`) ? workflowCopy(`presetOptions.${value}`) : value;
}

function presetBlockerText(blocker: PresetBlocker) {
  switch (blocker.kind) {
    case "required":
      return workflowCopy("presetBlockers.required", { label: presetParameterLabel(blocker.key) });
    case "range":
      return workflowCopy("presetBlockers.range", {
        label: presetParameterLabel(blocker.key),
        min: blocker.minimum,
        max: blocker.maximum,
      });
    case "tag_permission":
      return workflowCopy("presetBlockers.tagPermission");
    case "full_refresh_automated":
      return workflowCopy("presetBlockers.fullRefreshAutomated");
    case "invalid_date":
      return workflowCopy("presetBlockers.invalidDate", { label: presetParameterLabel(blocker.key) });
    case "release_range_open":
      return workflowCopy("presetReleaseRange.bothOpen");
    case "release_range_order":
      return workflowCopy("presetReleaseRange.order");
    case "sources_required":
      return workflowCopy("presetBlockers.sourcesRequired", { label: presetParameterLabel(blocker.key) });
    case "no_steps":
      return workflowCopy("presetBlockers.noSteps");
  }
}

function presetTagTemplateTokens(
  preset: WorkflowPreset,
  values: PresetFormValues,
  now: Date,
): WorkflowTagTemplateToken[] {
  return [
    { name: "date", description: workflowCopy("presetTokens.date"), value: utcShortDate(now) },
    {
      name: "target",
      description: workflowCopy("presetTokens.target"),
      value: workflowTagFragmentPreview(presetTargetValue(preset, values) || preset.target),
    },
  ];
}

function PresetParameterFields({
  idPrefix,
  preset,
  values,
  compact = false,
  onChange,
}: {
  idPrefix: string;
  /** Dialogs stack labels over two field columns; the page detail uses label-beside-control rows. */
  compact?: boolean;
  preset: WorkflowPreset;
  values: PresetFormValues;
  /** Receives functional updates so concurrent async fills do not overwrite each other. */
  onChange: Dispatch<SetStateAction<PresetFormValues>>;
}) {
  const { sources, loading: loadingSources } = useCompatibleRemoteSources();
  const visible = presetVisibleParameters(preset, values);
  const update = (key: string, value: string) => onChange((current) => ({ ...current, [key]: value }));
  const tagEnabled = presetTagEnabled(values);
  const tagTokens = presetTagTemplateTokens(preset, values, new Date());
  const tagPreview = workflowTagTemplatePreview(
    values.tagNameTemplate ?? "",
    workflowTagTemplateTokenValues(tagTokens),
  );
  const tagError =
    tagEnabled && (values.tagNameTemplate ?? "").trim()
      ? workflowTagTemplateBlockers(
          values.tagNameTemplate ?? "",
          tagTokens.map((token) => token.name),
        )[0]
      : undefined;

  // Catalog sources start with every compatible source selected; a stored or
  // prefilled selection is kept as it is.
  const catalogSourcesInitialized = useRef(false);
  useEffect(() => {
    if (catalogSourcesInitialized.current || loadingSources) return;
    catalogSourcesInitialized.current = true;
    if (!preset.parameters.some((parameter) => parameter.key === "sourceIds")) return;
    if (sources.length === 0) return;
    onChange((current) =>
      presetSourceIds(current.sourceIds).length > 0
        ? current
        : { ...current, sourceIds: sources.map((source) => source.id).join(",") },
    );
  }, [loadingSources, sources]);

  const renderField = (parameter: WorkflowPresetParameter) => {
    const id = `${idPrefix}-${parameter.key}`;
    const label = `${presetParameterLabel(parameter.key)}${parameter.required ? " *" : ""}`;
    const value = values[parameter.key] ?? "";
    const optional = parameter.key in PRESET_OPTIONAL_FILTERS;
    const optionalEnabled = optional && presetOptionalEnabled(values, parameter.key);
    // Switchable filters show their switch first and the control only while it is on.
    const optionalControl = (control: ReactNode) => (
      <>
        <SwitchControl
          label={workflowCopy(`presetOptionalFilters.${parameter.key}`)}
          description={workflowCopy(`presetOptionalFilters.${parameter.key}`)}
          checked={optionalEnabled}
          onCheckedChange={(next) => update(presetOptionalFlagKey(parameter.key), next ? "true" : "false")}
        />
        {optionalEnabled && control}
      </>
    );
    const field = (control: ReactNode, options: { hint?: ReactNode; labelFor?: boolean } = {}) => (
      <OptionField
        key={parameter.key}
        label={label}
        htmlFor={options.labelFor === false ? undefined : id}
        hint={options.hint}
        stacked={compact}
      >
        {control}
      </OptionField>
    );
    const stepSwitch = (checked: boolean, onCheckedChange: (next: boolean) => void) => (
      <SwitchControl
        label={workflowCopy(`presetSwitches.${parameter.key}`)}
        description={workflowCopy(`presetSwitchHints.${parameter.key}`)}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    );
    switch (parameter.kind) {
      case "boolean":
        return field(
          stepSwitch(value !== "false", (next) => update(parameter.key, next ? "true" : "false")),
          { labelFor: false },
        );
      case "voice_person":
        return field(
          <VoiceActorPicker
            id={id}
            personId={value}
            displayName={values[PRESET_PERSON_NAME_KEY] ?? ""}
            onChange={(personId, displayName) =>
              onChange((current) => ({ ...current, [parameter.key]: personId, [PRESET_PERSON_NAME_KEY]: displayName }))
            }
          />,
        );
      case "source_ids": {
        const checkboxes = (
          <RemoteSourceCheckboxes
            label={presetParameterLabel(parameter.key)}
            sources={sources}
            loading={loadingSources}
            selected={presetSourceIds(value)}
            onChange={(ids) => update(parameter.key, ids.join(","))}
          />
        );
        if (parameter.key !== "checkSourceIds") return field(checkboxes, { labelFor: false });
        const enabled = presetSourceCheckEnabled(values);
        return field(
          <>
            {stepSwitch(enabled, (next) =>
              onChange((current) => ({
                ...current,
                [presetOptionalFlagKey(parameter.key)]: next ? "true" : "false",
                // Turning the check on starts from every compatible source.
                [parameter.key]:
                  next && presetSourceIds(current[parameter.key]).length === 0
                    ? sources.map((source) => source.id).join(",")
                    : current[parameter.key],
              })),
            )}
            {enabled && checkboxes}
          </>,
          { labelFor: false },
        );
      }
      case "select":
        return field(
          <SegmentedControl
            label={presetParameterLabel(parameter.key)}
            value={value}
            onChange={(next) => update(parameter.key, next)}
            options={(parameter.options ?? []).map((option) => ({ value: option, label: presetOptionLabel(option) }))}
          />,
          { labelFor: false },
        );
      case "integer": {
        const input = (
          <Input
            id={id}
            fieldSize="sm"
            className="max-w-40"
            type="number"
            inputMode="numeric"
            aria-label={optional ? presetParameterLabel(parameter.key) : undefined}
            min={parameter.minimum}
            max={parameter.maximum}
            value={value}
            onChange={(event) => update(parameter.key, event.target.value)}
          />
        );
        if (!optional) return field(input);
        return field(optionalControl(input), {
          labelFor: false,
          hint: optionalEnabled ? undefined : workflowCopy("presetWorkLimitOff"),
        });
      }
      case "date": {
        // The release bounds share one row: a range switch, then each end with its own "No limit".
        if (parameter.key === "releaseTo") return null;
        if (parameter.key !== "releaseFrom") {
          return field(
            <Input
              id={id}
              fieldSize="sm"
              className="max-w-48"
              type="date"
              value={value}
              onChange={(event) => update(parameter.key, event.target.value)}
            />,
          );
        }
        const range = presetReleaseRange(values);
        const ends = [
          { key: "releaseFrom", open: range.fromOpen, openKey: PRESET_RELEASE_KEYS.fromOpen },
          { key: "releaseTo", open: range.toOpen, openKey: PRESET_RELEASE_KEYS.toOpen },
        ].filter((end) => preset.parameters.some((candidate) => candidate.key === end.key));
        return (
          <OptionField
            key="releaseRange"
            label={workflowCopy("presetReleaseRange.label")}
            hint={range.enabled ? workflowCopy("presetReleaseRange.inclusive") : undefined}
            stacked={compact}
          >
            <SwitchControl
              label={workflowCopy("presetReleaseRange.toggle")}
              description={workflowCopy("presetReleaseRange.toggle")}
              checked={range.enabled}
              onCheckedChange={(next) => update(PRESET_RELEASE_KEYS.enabled, next ? "true" : "false")}
            />
            {range.enabled && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {ends.map((end) => {
                  const endLabel = workflowCopy(`presetReleaseRange.${end.key}`);
                  const endId = `${idPrefix}-${end.key}`;
                  return (
                    <div key={end.key} className="flex min-w-0 items-center gap-2">
                      <label htmlFor={endId} className="w-8 shrink-0 text-xs text-muted-foreground">
                        {endLabel}
                      </label>
                      <Input
                        id={endId}
                        fieldSize="sm"
                        className="w-40"
                        type="date"
                        aria-label={presetParameterLabel(end.key)}
                        disabled={end.open}
                        value={end.open ? "" : (values[end.key] ?? "")}
                        onChange={(event) => update(end.key, event.target.value)}
                      />
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <Checkbox
                          checked={end.open}
                          aria-label={`${endLabel}: ${workflowCopy("presetReleaseRange.noLimit")}`}
                          onCheckedChange={(next) => update(end.openKey, next ? "true" : "false")}
                        />
                        {workflowCopy("presetReleaseRange.noLimit")}
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
          </OptionField>
        );
      }
      case "text_template":
        return (
          <TagTemplateField
            key={parameter.key}
            id={id}
            row={!compact}
            spanColumns={compact}
            enabled={tagEnabled}
            onEnabledChange={(next) => update(PRESET_TAG_ENABLED_KEY, next ? "true" : "false")}
            value={value}
            defaultValue={preset.defaultTagTemplate}
            tokens={tagTokens}
            preview={tagPreview}
            error={tagError}
            onChange={(next) => update(parameter.key, next)}
          />
        );
      default:
        // Circle and series targets accept a list; the server combines their catalogs.
        return field(
          <Input
            id={id}
            fieldSize="sm"
            className="max-w-md"
            value={value}
            placeholder={workflowCopy(`presetTargetPlaceholders.${parameter.key}`)}
            onChange={(event) => update(parameter.key, event.target.value)}
          />,
          { hint: workflowCopy("presetTargetsHint") },
        );
    }
  };

  // Input reads a catalog, the filter narrows its works without metadata, and
  // the actions sync, tag, or check them. Without metadata the filter has
  // nothing to narrow, so it stays hidden.
  const metadataEnabled = presetMetadataEnabled(values);
  return (
    <div className="grid divide-y">
      {PRESET_GROUPS.map((group) => {
        const parameters = visible.filter((parameter) => parameter.group === group);
        if (parameters.length === 0) return null;
        const groupTitleId = `${idPrefix}-group-${group}`;
        return (
          <section
            key={group}
            className={`grid min-w-0 content-start gap-4 py-4 first:pt-0 last:pb-0 ${compact ? "sm:grid-cols-2" : ""}`}
            aria-labelledby={groupTitleId}
          >
            <div className={compact ? "sm:col-span-2" : undefined}>
              <h4 id={groupTitleId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {workflowCopy(`presetGroups.${group}`)}
              </h4>
              {group === "filter" && metadataEnabled && (
                <p className="mt-1 text-xs text-muted-foreground">{workflowCopy("presetFilterHint")}</p>
              )}
            </div>
            {parameters.map(renderField)}
          </section>
        );
      })}
    </div>
  );
}

function PresetRunPanel({
  layout,
  preset,
  running,
  allowed,
  canTag,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  preset: WorkflowPreset;
  running: boolean;
  allowed: boolean;
  canTag: boolean;
  onRun: (inputs: Record<string, unknown>) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [values, setValues] = useState<PresetFormValues>(() => {
    // A detail page's Follow shortcut prefills this preset's target.
    const prefill = readWorkflowRunPrefill(preset.code);
    const targets = Object.fromEntries(
      Object.entries(prefill).filter(([key]) => preset.parameters.some((parameter) => parameter.key === key)),
    );
    return Object.keys(targets).length > 0 ? presetValuesFromInputs(preset, targets) : presetDefaultValues(preset);
  });
  useEffect(() => clearWorkflowRunPrefill(), []);
  useEffect(() => {
    onTriggerRunOptionsChange?.({ code: preset.code, presetValues: values });
  }, [preset.code, values, onTriggerRunOptionsChange]);
  const blockers = presetBlockers(preset, values, { canTag, automated: false });
  const tagTemplate = (values.tagNameTemplate ?? "").trim();
  const tagInvalid =
    presetTagEnabled(values) &&
    tagTemplate !== "" &&
    workflowTagTemplateBlockers(
      tagTemplate,
      presetTagTemplateTokens(preset, values, new Date()).map((token) => token.name),
    ).length > 0;
  const canSubmit = allowed && blockers.length === 0 && !tagInvalid;
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!canSubmit}
        onClick={() => void onRun(presetInputsPayload(preset, values))}
      />
    ),
    options: (
      <div className="grid gap-5">
        <PresetParameterFields idPrefix="preset-run" preset={preset} values={values} onChange={setValues} />
        {blockers.length > 0 && <RunBlockerNote>{presetBlockerText(blockers[0])}</RunBlockerNote>}
      </div>
    ),
  });
}

function DLsitePopularRunPanel({
  layout,
  running,
  allowed,
  onRun,
  onTriggerRunOptionsChange,
}: {
  layout: RunFormLayout;
  running: boolean;
  allowed: boolean;
  onRun: (options: DLsitePopularRunOptions) => Promise<void>;
  onTriggerRunOptionsChange?: (options: CurrentTriggerRunOptions) => void;
}) {
  const [period, setPeriod] = useState<DLsitePopularPeriod>("day");
  const [recentOnly, setRecentOnly] = useState(true);
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const releaseWindow: "30d" | "" = period === "year" ? "" : recentOnly ? "30d" : "";
  const defaultTagTemplate = dlsitePopularDefaultTagTemplate(period);
  const [tagEnabled, setTagEnabled] = useState(true);
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
    { value: "day", label: workflowCopy("period24Hours") },
    { value: "week", label: workflowCopy("period7Days") },
    { value: "month", label: workflowCopy("period30Days") },
    { value: "year", label: workflowCopy("periodAnnual") },
  ];

  useEffect(() => {
    if (!tagCustomized) setTagNameTemplate(defaultTagTemplate);
  }, [defaultTagTemplate, tagCustomized]);

  const tagReady = !tagEnabled || (!tagError && Boolean(tagPreview.value));
  useEffect(() => {
    onTriggerRunOptionsChange?.({
      code: "dlsite_popular_collection",
      systemConfig: {
        ...workflowSystemTriggerConfig("dlsite_popular_collection", null),
        period,
        releaseWindow,
        year: period === "year" ? year : 0,
        tagNameTemplate,
        skipTag: !tagEnabled,
      },
    });
  }, [period, releaseWindow, year, tagNameTemplate, tagEnabled, onTriggerRunOptionsChange]);
  return layout({
    run: (
      <WorkflowRunButton
        running={running}
        disabled={!allowed || !tagReady}
        onClick={() =>
          void onRun({
            period,
            releaseWindow,
            year: period === "year" ? year : 0,
            tagNameTemplate: tagEnabled ? tagNameTemplate.trim() : "",
            skipTag: !tagEnabled,
          })
        }
      />
    ),
    options: (
      <RunOptionRows>
        <OptionField label={workflowCopy("rankingPeriod")}>
          <SegmentedControl
            label={workflowCopy("rankingPeriod")}
            value={period}
            onChange={setPeriod}
            options={periodOptions}
          />
        </OptionField>
        {period === "year" ? (
          <OptionField label={workflowCopy("rankingYear")} htmlFor="dlsite-popular-year">
            <NativeSelect
              id="dlsite-popular-year"
              fieldSize="sm"
              className="max-w-48"
              value={year}
              onChange={(event) => setYear(Number(event.target.value))}
            >
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                  {item === currentYear ? ` (${workflowCopy("current")})` : ""}
                </option>
              ))}
            </NativeSelect>
          </OptionField>
        ) : (
          <OptionField label={workflowCopy("recentReleasesOnly")}>
            <SwitchControl
              label={workflowCopy("onlyWorksReleased30Days")}
              description={workflowCopy("recentReleasesDescription")}
              checked={recentOnly}
              onCheckedChange={setRecentOnly}
            />
          </OptionField>
        )}
        <TagTemplateField
          id="dlsite-popular-tag-template"
          row
          enabled={tagEnabled}
          onEnabledChange={setTagEnabled}
          value={tagNameTemplate}
          defaultValue={defaultTagTemplate}
          tokens={tagTokens}
          preview={tagPreview}
          error={tagError}
          onChange={(next) => {
            setTagCustomized(next !== defaultTagTemplate);
            setTagNameTemplate(next);
          }}
        />
      </RunOptionRows>
    ),
  });
}

function RunDetail({
  run,
  candidates,
  events,
  loading = false,
  onCandidateUpdate,
  onRunAction,
  readOnly,
  canSyncMetadata,
}: {
  run: WorkflowRunDetail | WorkflowRun | null;
  candidates: WorkflowCandidate[];
  events: WorkflowEvent[];
  loading?: boolean;
  onCandidateUpdate: () => Promise<void>;
  onRunAction: () => Promise<void>;
  readOnly: boolean;
  canSyncMetadata: boolean;
}) {
  if (!run) {
    return loading ? (
      <RunDetailSkeleton />
    ) : (
      <p className="py-6 text-center text-sm text-muted-foreground">{workflowCopy("selectRunNodeDetail")}</p>
    );
  }
  const nodeRuns = "nodeRuns" in run ? run.nodeRuns : [];
  return (
    <div className="min-w-0 space-y-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="min-w-0 break-words text-base font-semibold leading-6">{run.displayName}</h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <RunStatusBadge status={run.status} />
            <span className="tabular-nums">#{run.id}</span>
          </div>
        </div>
        {!readOnly && <RunActions run={run} onRunAction={onRunAction} />}
      </header>
      {!loading && <RunTransferProgress run={run} />}
      <RunFacts run={run} />
      <RunStats run={run} />
      {"metadataIssues" in run && run.metadataIssues && run.metadataIssues.encountered > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
          <p className="min-w-0">
            {i18n.t(run.metadataIssues.pending > 0 ? "metadataIssues.pendingForRun" : "metadataIssues.resolvedForRun", {
              count: run.metadataIssues.pending,
            })}
          </p>
          {canSyncMetadata && run.metadataIssues.pending > 0 && (
            <Button size="sm" variant="outline" onClick={() => openMetadataIssues(run.id)}>
              {i18n.t("metadataIssues.openIssues")}
            </Button>
          )}
        </div>
      )}
      {!loading && candidates.length > 0 && (
        <RunItems candidates={candidates} onCandidateUpdate={onCandidateUpdate} readOnly={readOnly} />
      )}
      {!loading && <RunSteps nodeRuns={nodeRuns} />}
      {!loading && <RunDiagnostics events={events} nodeRuns={nodeRuns} summaryJson={run.summaryJson} />}
    </div>
  );
}

function RunDetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SkeletonLine className="h-5 w-48 max-w-full" />
          <SkeletonLine className="h-5 w-16" />
        </div>
        <SkeletonLine className="h-3 w-64 max-w-full" />
        <SkeletonLine className="h-3 w-56 max-w-full" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonLine key={index} className="h-6 w-20" />
        ))}
      </div>
      <SkeletonLine className="h-16 w-full" />
    </div>
  );
}

function RunStats({ run }: { run: WorkflowRun }) {
  const review = pendingReviewCount(run);
  const failed = run.failedNodeRuns + run.failedJobs;
  const skipped = run.skippedNodeRuns + run.skippedJobs;
  const stats: Array<{ key: string; value: string; label: string; tone?: "warning" | "error" }> = [
    { key: "nodes", value: `${run.completedNodeRuns}/${run.nodeRunCount}`, label: workflowCopy("nodes") },
    { key: "jobs", value: `${run.completedJobs}/${run.jobCount}`, label: workflowCopy("jobs") },
  ];
  if (review > 0)
    stats.push({ key: "review", value: `${review}`, label: workflowCopy("pendingReview"), tone: "warning" });
  if (failed > 0) stats.push({ key: "failed", value: `${failed}`, label: workflowCopy("failedItems"), tone: "error" });
  if (skipped > 0) stats.push({ key: "skipped", value: `${skipped}`, label: workflowCopy("skipped") });
  return (
    <dl className="flex flex-wrap gap-1.5 text-xs">
      {stats.map((stat) => (
        <div
          key={stat.key}
          className={`inline-flex items-baseline gap-1 rounded-md px-2 py-1 ${
            stat.tone === "error"
              ? "bg-error-surface text-error-foreground"
              : stat.tone === "warning"
                ? "bg-warning-surface text-warning-foreground"
                : "bg-muted/50"
          }`}
        >
          <dt className={`order-2 ${stat.tone ? "" : "text-muted-foreground"}`}>{stat.label}</dt>
          <dd className="order-1 font-semibold tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunItems({
  candidates,
  onCandidateUpdate,
  readOnly,
}: {
  candidates: WorkflowCandidate[];
  onCandidateUpdate: () => Promise<void>;
  readOnly: boolean;
}) {
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{workflowCopy("noReviewableItems")}</p>;
  }
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="text-xs font-semibold text-muted-foreground">
        {workflowCopy("candidates")} · {candidates.length}
      </h4>
      <div className="min-w-0 divide-y rounded-md border">
        {candidates.map((candidate) => (
          <CandidateReviewCard
            key={candidate.id}
            candidate={candidate}
            onCandidateUpdate={onCandidateUpdate}
            readOnly={readOnly}
          />
        ))}
      </div>
    </section>
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
    <div className="grid min-w-0 gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={candidate.externalKey || candidate.type}>
            {candidate.externalKey || candidate.type}
          </div>
          <div className="break-all text-xs text-muted-foreground">
            {candidate.type} · updated {candidate.updatedAt}
          </div>
        </div>
        <StatusBadge status={candidate.status} />
      </div>

      {candidate.type === "local_fetch_merge_cleanup" && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">
            {archivedRoots.length > 0 ? workflowCopy("archivedLocalRoots") : workflowCopy("oldLocalLocations")}
          </div>
          {archivedRoots.map((root) => (
            <div key={root.folderId} className="space-y-1 border-b py-2 last:border-b-0">
              <div className="break-all font-medium">{root.originalPath}</div>
              <div className="truncate text-muted-foreground" title={root.archivePath}>
                {root.archivePath}
              </div>
              <div className="text-muted-foreground">
                {root.fileCount} files · {formatBytes(root.sizeBytes)}
              </div>
              {root.files.slice(0, 12).map((file) => (
                <div key={file.path} className="flex gap-2 pl-2">
                  <span className="min-w-0 flex-1 truncate" title={file.path}>
                    {file.path}
                  </span>
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
                  <span className="min-w-0 flex-1 truncate" title={location.path}>
                    {location.path}
                  </span>
                  {location.sizeBytes !== null && (
                    <span className="shrink-0 text-muted-foreground">{formatBytes(location.sizeBytes)}</span>
                  )}
                </div>
              ))
            : archivedRoots.length === 0 && (
                <div className="text-muted-foreground">{workflowCopy("noSelectableLocalLocations")}</div>
              )}
          {archivedRoots.length === 0 && cleanupLocations.length > 8 && (
            <div className="pt-1 text-muted-foreground">+{cleanupLocations.length - 8} more</div>
          )}
        </div>
      )}

      {candidate.type === "local_duplicate_work_folder" && (
        <div className="min-w-0 rounded-md border bg-muted/40 p-2 text-xs">
          <div className="mb-1 font-medium">{workflowCopy("duplicateLocalFolders")}</div>
          {duplicateFolders.map((folder) => (
            <div key={folder.relPath} className="grid gap-0.5 py-1">
              <div className="truncate" title={folder.relPath}>
                {folder.relPath}
              </div>
              <div className="text-muted-foreground">
                {folder.files} files · {folder.audioFiles} audio · {formatBytes(folder.sizeBytes)}
              </div>
            </div>
          ))}
        </div>
      )}

      {originBlocked && (
        <div className="min-w-0 rounded-md border border-warning-border bg-warning-surface p-3 text-sm">
          <div className="font-medium text-warning-foreground">{workflowCopy("outboundOriginBlocked")}</div>
          <div className="mt-1 break-all font-mono text-xs text-warning-foreground">
            {blockedOrigin || workflowCopy("originNotRecorded")}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{workflowCopy("originBlockedDescription")}</p>
        </div>
      )}

      {candidate.type !== "local_fetch_merge_cleanup" &&
        candidate.type !== "local_duplicate_work_folder" &&
        !originBlocked && (
          <JsonPreview value={candidate.payloadJson} empty={workflowCopy("noCandidatePayload")} compact />
        )}
      {hasNonEmptyJSON(candidate.decisionJson) && (
        <JsonPreview value={candidate.decisionJson} empty={workflowCopy("noDecisionPayload")} compact />
      )}
      {needsReview && !readOnly && (
        <div className="flex flex-wrap gap-2">
          {originBlocked && (
            <>
              {blockedSourceID !== null && blockedSourceID > 0 && (
                <Button size="sm" variant="outline" onClick={() => openRemoteSourceConfiguration(blockedSourceID)}>
                  <Settings2 className="h-4 w-4" />
                  {workflowCopy("configureSource")}
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
                {workflowCopy("retryFetch")}
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && cleanupLocations.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void cleanup("mark_unavailable")}>
                {workflowCopy("hideOldLocations")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                onClick={() => setConfirmDeleteOldFiles(true)}
              >
                {workflowCopy("deleteOldFiles")}
              </Button>
            </>
          )}
          {candidate.type === "local_fetch_merge_cleanup" && archivedRoots.length > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => void reviewArchive("keep_archived")}>
                {workflowCopy("keepArchived")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-destructive/40 text-destructive hover:text-destructive"
                onClick={() => setArchiveDeleteStep(1)}
              >
                {workflowCopy("deleteArchive")}
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
                {workflowCopy("markResolved")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await api.updateWorkflowCandidate(candidate.id, { status: "ignored" });
                  await onCandidateUpdate();
                }}
              >
                {workflowCopy("ignore")}
              </Button>
            </>
          )}
        </div>
      )}
      {confirmDeleteOldFiles && (
        <div className="rounded-md border border-error-border bg-error-surface p-3">
          <div className="text-sm font-semibold text-error-foreground">{workflowCopy("deleteOldLocalFilesTitle")}</div>
          <div className="mt-1 text-sm text-muted-foreground">{workflowCopy("deleteOldLocalFilesDescription")}</div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmDeleteOldFiles(false)}>
              {workflowCopy("cancel")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => void cleanup("delete_files")}>
              {workflowCopy("deleteFiles")}
            </Button>
          </div>
        </div>
      )}
      {archiveDeleteStep > 0 && (
        <div className="rounded-md border border-error-border bg-error-surface p-3">
          <div className="text-sm font-semibold text-error-foreground">
            {archiveDeleteStep === 1 ? workflowCopy("reviewArchivedDirectories") : workflowCopy("finalConfirmation")}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {archiveDeleteStep === 1 ? workflowCopy("archivePermanentlyRemoved") : workflowCopy("cannotUndoKeep")}
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
              {workflowCopy("cancel")}
            </Button>
            {archiveDeleteStep === 1 ? (
              <Button size="sm" variant="outline" onClick={() => setArchiveDeleteStep(2)}>
                {workflowCopy("continue")}
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => void reviewArchive("delete_archived")}>
                {workflowCopy("permanentlyDelete")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const emptyEvents: WorkflowEvent[] = [];
const emptyNodeRuns: WorkflowNodeRun[] = [];

/** Stages and log of the definition's most recent run; an active run streams into the log. */
function DefinitionRunMonitor({
  nodes,
  recentRuns,
  onOpenRun,
}: {
  nodes: WorkflowNode[];
  recentRuns: WorkflowRun[];
  onOpenRun?: (run: WorkflowRun) => void;
}) {
  const latestRun = useMemo(
    () => recentRuns.reduce<WorkflowRun | null>((latest, run) => (!latest || run.id > latest.id ? run : latest), null),
    [recentRuns],
  );
  const watched = useWorkflowRunWatcher(latestRun?.id ?? null, isActiveRunStatus(latestRun?.status ?? ""));
  const detail = latestRun && watched.run?.id === latestRun.id ? watched.run : null;
  const nodeRuns = detail?.nodeRuns;
  const stages = useMemo(() => workflowStages(nodes, nodeRuns), [nodeRuns, nodes]);
  return (
    <WorkflowRunMonitor
      stages={stages}
      run={detail ?? latestRun}
      events={detail ? watched.events : emptyEvents}
      nodeRuns={nodeRuns ?? emptyNodeRuns}
      onOpenRun={onOpenRun}
    />
  );
}

function RecentWorkflowRuns({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (run: WorkflowRun) => void }) {
  return (
    <WorkflowSection title={workflowCopy("recentRuns")}>
      <RecentRunList runs={runs} empty={workflowCopy("noRecentRuns")} onOpen={onOpen} />
    </WorkflowSection>
  );
}

function supportedAutomationTriggerTypes(definition: WorkflowDefinition, isPreset = false): AutomationTriggerType[] {
  if (definition.scope === "system" && isPreset) return automationTriggerTypes;
  if (definition.scope === "system" && definition.code === "availability_watch") return ["schedule"];
  if (definition.scope === "system" && definition.code === "local_library_scan")
    return ["startup", "filesystem_event", "schedule"];
  if (definition.scope === "system" && definition.code === "metadata_sync") return ["schedule"];
  if (definition.scope === "system" && configurableSystemWorkflowCodes.has(definition.code))
    return automationTriggerTypes;
  return [];
}

function workflowTriggerCondition(trigger: WorkflowTrigger) {
  if (trigger.triggerType === "startup") return workflowCopy("whenServiceStarts");
  if (trigger.triggerType === "filesystem_event") return workflowCopy("whenFoldersChange");
  if (trigger.triggerType === "schedule") {
    const interval = parseJSONRecord(trigger.scheduleJson).intervalMinutes;
    if (typeof interval === "number") return workflowCopy("everyMinutes", { count: interval });
    return workflowCopy("intervalSchedule");
  }
  return trigger.triggerType.replace(/_/g, " ");
}

function workflowTriggerNextRun(trigger: WorkflowTrigger) {
  if (!trigger.enabled) return workflowCopy("paused");
  if (trigger.triggerType === "startup") return workflowCopy("nextServiceStart");
  if (trigger.triggerType === "filesystem_event") return workflowCopy("watchingFolderChanges");
  return trigger.nextRunAt ?? workflowCopy("pendingCalculation");
}

function WorkflowAutomationPanel({
  definition,
  isPreset = false,
  triggers,
  canManage,
  readOnly = false,
  onCreate,
  onEdit,
  onToggle,
}: {
  definition: WorkflowDefinition;
  isPreset?: boolean;
  triggers: WorkflowTrigger[];
  canManage: boolean;
  /** Demo keeps trigger controls visible and opens existing triggers read-only. */
  readOnly?: boolean;
  onCreate: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEdit: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
  onToggle: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
}) {
  const supportedTypes = supportedAutomationTriggerTypes(definition, isPreset);
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
  const canAddStartup = supportedTypes.includes("startup") && !hasStartup;
  const canAddSchedule =
    supportedTypes.includes("schedule") && (definition.code !== "availability_watch" || !hasSchedule);
  return (
    <WorkflowSection
      title={workflowCopy("triggers")}
      label={workflowCopy("workflowAutomations")}
      actions={
        (canManage || readOnly) && supportedTypes.length > 0 ? (
          <>
            {canAddStartup && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={(event) => onCreate("startup", event.currentTarget)}
              >
                <Plus className="h-4 w-4" />
                {workflowCopy("runAtStartup")}
              </Button>
            )}
            {canAddSchedule && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={(event) => onCreate("schedule", event.currentTarget)}
              >
                <CalendarClock className="h-4 w-4" />
                {workflowCopy("addSchedule")}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {orderedTriggers.length > 0 ? (
        <ul className="-mx-2">
          {orderedTriggers.map((trigger) => {
            const configurable = supportedTypes.includes(trigger.triggerType as AutomationTriggerType);
            const manageable = canManage && configurable;
            const inspectable = manageable || (readOnly && configurable);
            const openLabel = manageable
              ? `Edit ${trigger.displayName}`
              : workflowCopy("viewTrigger", { name: trigger.displayName });
            const next =
              trigger.enabled && trigger.triggerType === "schedule" && trigger.nextRunAt ? (
                <>
                  {workflowCopy("next")} <RelativeTime value={trigger.nextRunAt} fallback="" />
                </>
              ) : trigger.enabled && trigger.triggerType === "startup" ? null : (
                workflowTriggerNextRun(trigger)
              );
            return (
              <li key={trigger.id} className="flex min-h-11 min-w-0 items-center gap-3 rounded-md px-2 py-1.5">
                <Switch
                  checked={trigger.enabled}
                  disabled={!manageable}
                  onCheckedChange={(enabled) => void onToggle(trigger, enabled)}
                  aria-label={`${trigger.enabled ? workflowCopy("pause") : workflowCopy("enable")} ${trigger.displayName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-sm ${trigger.enabled ? "" : "text-muted-foreground"}`}>
                    {trigger.displayName}
                  </div>
                  <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <span>{workflowTriggerCondition(trigger)}</span>
                    {next && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{next}</span>
                      </>
                    )}
                    {trigger.lastSuccessAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {workflowCopy("lastSuccess")} <RelativeTime value={trigger.lastSuccessAt} fallback="" />
                        </span>
                      </>
                    )}
                  </div>
                  {isPreset && presetInputsNeedReconfiguration(parseJSONRecord(trigger.configJson).inputs) ? (
                    <div className="mt-0.5 text-xs text-warning-foreground">
                      {workflowCopy("presetTriggerNeedsReconfiguration")}
                    </div>
                  ) : (
                    trigger.lastErrorMessage && (
                      <div className="mt-0.5 break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
                        {workflowCopy("lastError")}: {trigger.lastErrorMessage}
                      </div>
                    )
                  )}
                </div>
                {inspectable && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    onClick={(event) => onEdit(trigger, event.currentTarget)}
                    title={openLabel}
                    aria-label={openLabel}
                  >
                    {manageable ? <Edit3 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">
          {supportedTypes.length > 0 ? workflowCopy("noAutomaticTriggers") : workflowCopy("noConfigurableTriggers")}
        </p>
      )}
    </WorkflowSection>
  );
}

function TriggerModal({
  definition,
  preset = null,
  canTag = false,
  trigger,
  readOnly = false,
  initialTriggerType,
  currentRunOptions,
  anchorRef,
  onClose,
  onSaved,
  onDeleted,
}: {
  definition: WorkflowDefinition;
  preset?: WorkflowPreset | null;
  canTag?: boolean;
  trigger: WorkflowTrigger | null;
  readOnly?: boolean;
  initialTriggerType: CreatableAutomationTriggerType;
  currentRunOptions?: CurrentTriggerRunOptions | null;
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: (trigger: WorkflowTrigger) => void;
  onDeleted: () => void;
}) {
  const triggerType: AutomationTriggerType =
    trigger?.triggerType === "startup" ||
    trigger?.triggerType === "filesystem_event" ||
    trigger?.triggerType === "schedule"
      ? trigger.triggerType
      : initialTriggerType;
  const [systemConfig, setSystemConfig] = useState<SystemWorkflowTriggerConfig>(() =>
    trigger
      ? workflowSystemTriggerConfig(definition.code, trigger)
      : (currentRunOptions?.systemConfig ?? workflowSystemTriggerConfig(definition.code, null)),
  );
  const [displayName, setDisplayName] = useState(
    trigger?.displayName ??
      (triggerType === "startup" ? workflowCopy("runAtStartup") : workflowCopy("scheduledWorkflow")),
  );
  const enabled = trigger?.enabled ?? true;
  const [intervalMinutes, setIntervalMinutes] = useState(() => {
    const value = parseJSONRecord(trigger?.scheduleJson ?? "").intervalMinutes;
    return typeof value === "number" ? value : 60;
  });
  const [presetValues, setPresetValues] = useState<PresetFormValues>(() =>
    preset
      ? trigger
        ? presetValuesFromInputs(preset, parseJSONRecord(trigger.configJson).inputs)
        : (currentRunOptions?.presetValues ?? presetDefaultValues(preset))
      : {},
  );
  const isMetadataSync = definition.code === "metadata_sync";
  const [metadataSyncValues, setMetadataSyncValues] = useState<MetadataSyncFormValues>(() =>
    trigger
      ? metadataSyncValuesFromConfig(parseJSONRecord(trigger.configJson))
      : (currentRunOptions?.metadataSync ?? metadataSyncDefaultValues()),
  );
  const customizable =
    Boolean(preset) ||
    isMetadataSync ||
    definition.code === "remote_popular_collection" ||
    definition.code === "dlsite_popular_collection";
  const [customize, setCustomize] = useState(() => customizable && Boolean(trigger));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const presetTriggerBlockers = preset
    ? presetBlockers(preset, presetValues, { canTag, automated: true }).map((blocker) => presetBlockerText(blocker))
    : [];
  const systemConfigBlockers = isMetadataSync
    ? metadataSyncBlockers(metadataSyncValues).map(metadataSyncBlockerText)
    : workflowSystemTriggerConfigBlockers(definition.code, systemConfig);
  // An unfiltered follow syncs every catalog work without metadata on each
  // automated run. It is allowed, but recommend a filter before saving one.
  const unfilteredFollowWarning = Boolean(preset && presetRunsUnfiltered(preset, presetValues));
  const automationBlockers = [
    ...(triggerType === "schedule" && (intervalMinutes < 5 || intervalMinutes > 10080)
      ? [workflowCopy("intervalRange")]
      : []),
    ...systemConfigBlockers,
    ...presetTriggerBlockers,
  ];

  useEffect(() => {
    if (definition.code !== "remote_popular_collection" || systemConfig.sourceId > 0) return;
    let active = true;
    api
      .listLibrarySources()
      .then((sources) => {
        if (!active) return;
        const source = sources.find(
          (item) => item.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(item.sourceType),
        );
        if (source)
          setSystemConfig((current) => (current.sourceId > 0 ? current : { ...current, sourceId: source.id }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [definition.code, systemConfig.sourceId]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      if (automationBlockers.length > 0) throw new Error(automationBlockers[0]);
      const configPayload = preset
        ? presetInputsPayload(preset, presetValues)
        : isMetadataSync
          ? metadataSyncPayload(metadataSyncValues)
          : workflowSystemTriggerConfigPayload(definition.code, triggerType, systemConfig);
      const payload = {
        workflowDefinitionId: definition.id,
        displayName,
        triggerType,
        enabled,
        scheduleJson:
          triggerType === "schedule"
            ? JSON.stringify({ intervalMinutes })
            : (trigger?.scheduleJson ?? JSON.stringify({ type: "startup" })),
        configJson: preset ? JSON.stringify({ inputs: configPayload }) : JSON.stringify(configPayload),
        nextRunAt: null,
      };
      const saved = trigger
        ? await api.updateWorkflowTrigger(trigger.id, payload)
        : await api.createWorkflowTrigger(payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : workflowCopy("saveFailed"));
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
      setError(err instanceof Error ? err.message : workflowCopy("deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const showSystemOptions = definition.code === "local_library_scan" || customize;
  const showPresetOptions = Boolean(preset && customize);
  const setCustomizeAndReset = (next: boolean) => {
    if (!next) {
      if (preset) setPresetValues(currentRunOptions?.presetValues ?? presetDefaultValues(preset));
      else if (isMetadataSync) setMetadataSyncValues(currentRunOptions?.metadataSync ?? metadataSyncDefaultValues());
      else setSystemConfig(currentRunOptions?.systemConfig ?? workflowSystemTriggerConfig(definition.code, null));
    }
    setCustomize(next);
  };

  return (
    <Modal
      title={
        trigger
          ? workflowCopy("editTrigger")
          : triggerType === "startup"
            ? workflowCopy("newStartupTrigger")
            : workflowCopy("newSchedule")
      }
      onClose={onClose}
      dismissible={!customize && !saving}
      anchorRef={anchorRef}
      popoverClassName={customize ? "w-[min(42rem,calc(100vw-1.5rem))]" : "w-[min(27rem,calc(100vw-1.5rem))]"}
    >
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-3 border-0 p-0">
        <Field label={workflowCopy("name")}>
          <Input
            fieldSize="sm"
            value={displayName}
            disabled={triggerType === "filesystem_event"}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        {triggerType === "schedule" && (
          <Field label={workflowCopy("intervalMinutes")}>
            <Input
              fieldSize="sm"
              type="number"
              min={5}
              max={10080}
              value={intervalMinutes}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            />
          </Field>
        )}
        {customizable && (
          <label className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <Checkbox
              checked={customize}
              onCheckedChange={setCustomizeAndReset}
              aria-label={workflowCopy("customizeTrigger")}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{workflowCopy("customizeTrigger")}</span>
              <span className="text-xs text-muted-foreground">{workflowCopy("customizeTriggerDescription")}</span>
            </span>
          </label>
        )}
        {(showPresetOptions || showSystemOptions) && (
          <section className="grid min-w-0 gap-3 border-t pt-4" aria-label={workflowCopy("runOptions")}>
            {customize && (
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {workflowCopy("runOptions")}
              </h4>
            )}
            {showPresetOptions && preset ? (
              <PresetParameterFields
                idPrefix="preset-trigger"
                compact
                preset={preset}
                values={presetValues}
                onChange={setPresetValues}
              />
            ) : showSystemOptions && isMetadataSync ? (
              <MetadataSyncFields
                idPrefix="metadata-sync-trigger"
                compact
                values={metadataSyncValues}
                onChange={setMetadataSyncValues}
              />
            ) : showSystemOptions ? (
              <SystemWorkflowTriggerFields
                definitionCode={definition.code}
                triggerType={triggerType}
                value={systemConfig}
                onChange={setSystemConfig}
              />
            ) : null}
          </section>
        )}
        {unfilteredFollowWarning && (
          <div
            role="note"
            className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground"
          >
            {workflowCopy("presetUnfilteredAutomation")}
          </div>
        )}
        {automationBlockers.length > 0 && (
          <div className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {automationBlockers.map((blocker) => (
              <div key={blocker}>{blocker}</div>
            ))}
          </div>
        )}
        {error && <ErrorPanel error={error} />}
        <div className="flex justify-end gap-2">
          {trigger && triggerType !== "filesystem_event" && (
            <Button variant="outline" onClick={remove} disabled={saving}>
              <Trash2 className="h-4 w-4" />
              {workflowCopy("delete")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {workflowCopy("cancel")}
          </Button>
          <Button onClick={save} disabled={saving || automationBlockers.length > 0 || !displayName.trim()}>
            <Save className="h-4 w-4" />
            {saving ? workflowCopy("saving") : trigger ? workflowCopy("save") : workflowCopy("addTrigger")}
          </Button>
        </div>
      </fieldset>
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
    scanMode: record.scanMode === "full" ? "full" : "incremental",
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
    skipTag: record.skipTag === true,
  };
}

function workflowSystemTriggerConfigPayload(
  definitionCode: string,
  triggerType: AutomationTriggerType,
  value: SystemWorkflowTriggerConfig,
) {
  if (definitionCode === "local_library_scan") {
    return triggerType === "filesystem_event"
      ? { followUpRun: false, scanMode: value.scanMode }
      : { followUpRun: value.followUpRun };
  }
  if (definitionCode === "remote_popular_collection") {
    return {
      sourceId: value.sourceId,
      action: value.action,
      limit: value.limit,
      tagNameTemplate: value.tagNameTemplate.trim(),
      skipTag: value.skipTag,
    };
  }
  if (definitionCode === "dlsite_popular_collection") {
    return {
      period: value.period,
      releaseWindow: value.period === "year" ? "" : value.releaseWindow,
      year: value.period === "year" ? value.year : 0,
      tagNameTemplate: value.tagNameTemplate.trim(),
      skipTag: value.skipTag,
    };
  }
  return {};
}

function workflowSystemTriggerConfigBlockers(definitionCode: string, value: SystemWorkflowTriggerConfig) {
  if (definitionCode === "remote_popular_collection") {
    return [
      ...(value.sourceId <= 0 ? [workflowCopy("selectRemoteSource")] : []),
      ...(value.action === "fetch" ? [workflowCopy("automatedTrackOnly")] : []),
      ...(value.limit <= 0 || value.limit > 100 ? [workflowCopy("workLimitRange")] : []),
      ...(!value.skipTag
        ? workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "remote_name", "source_code", "action"])
        : []),
    ];
  }
  if (definitionCode === "dlsite_popular_collection") {
    return [
      ...(value.period === "year" && (value.year < 2000 || value.year > new Date().getUTCFullYear())
        ? [workflowCopy("yearRange", { year: new Date().getUTCFullYear() })]
        : []),
      ...(!value.skipTag
        ? workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "period", "release_window", "year"])
        : []),
    ];
  }
  return [];
}

function workflowTagTemplateBlockers(template: string, tokens: string[]) {
  if (!template.trim()) return [workflowCopy("tagTemplateRequired")];
  if ([...template].length > TAG_TEMPLATE_MAX_LENGTH)
    return [workflowCopy("tagTemplateMaxLength", { count: TAG_TEMPLATE_MAX_LENGTH })];
  const matches = template.match(/\{[a-z_]+\}/g) ?? [];
  const unsupported = matches.find((token) => !tokens.includes(token.slice(1, -1)));
  if (unsupported) return [workflowCopy("unsupportedTemplatePlaceholder", { placeholder: unsupported })];
  if (/[{}]/.test(template.replace(/\{[a-z_]+\}/g, ""))) return [workflowCopy("invalidTemplatePlaceholder")];
  return [];
}

function SystemWorkflowTriggerFields({
  definitionCode,
  triggerType,
  value,
  onChange,
}: {
  definitionCode: string;
  triggerType: AutomationTriggerType;
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
    if (triggerType === "filesystem_event") {
      return (
        <div className="grid gap-1.5 text-sm">
          <div id="local-scan-mode-label" className="font-medium">
            {workflowCopy("scanMode")}
          </div>
          <div
            className="grid grid-cols-2 rounded-md border bg-muted/30 p-1"
            role="radiogroup"
            aria-labelledby="local-scan-mode-label"
          >
            {(["incremental", "full"] as const).map((scanMode) => {
              const selected = value.scanMode === scanMode;
              return (
                <button
                  key={scanMode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`h-9 rounded px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => onChange({ ...value, scanMode })}
                >
                  {scanMode === "incremental" ? workflowCopy("incremental") : workflowCopy("full")}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-medium">{workflowCopy("followUpRun")}</div>
          <div className="text-xs text-muted-foreground">{workflowCopy("followUpEachDescription")}</div>
        </div>
        <Switch
          checked={value.followUpRun}
          onCheckedChange={(followUpRun) => onChange({ ...value, followUpRun })}
          aria-label={workflowCopy("followUpRun")}
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
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={workflowCopy("remoteSource")}>
          <NativeSelect
            fieldSize="sm"
            value={value.sourceId}
            disabled={loadingSources || compatibleSources.length === 0}
            onChange={(event) => onChange({ ...value, sourceId: Number(event.target.value) })}
          >
            {compatibleSources.length === 0 && (
              <option value={0}>
                {loadingSources ? workflowCopy("loadingSources") : workflowCopy("noCompatibleSource")}
              </option>
            )}
            {compatibleSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.displayName}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label={workflowCopy("action")}>
          <NativeSelect
            fieldSize="sm"
            value={value.action}
            onChange={(event) => onChange({ ...value, action: event.target.value === "fetch" ? "fetch" : "track" })}
          >
            <option value="track">{workflowCopy("track")}</option>
            <option value="fetch" disabled>
              {workflowCopy("fetchManualOnly")}
            </option>
          </NativeSelect>
        </Field>
        <Field label={workflowCopy("workLimit")}>
          <NativeSelect
            fieldSize="sm"
            value={value.limit}
            onChange={(event) => onChange({ ...value, limit: Number(event.target.value) })}
          >
            {[10, 25, 50, 100].map((limit) => (
              <option key={limit} value={limit}>
                {workflowCopy("worksCount", { count: limit })}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TagTemplateField
          id="remote-trigger-tag-template"
          enabled={!value.skipTag}
          onEnabledChange={(enabled) => onChange({ ...value, skipTag: !enabled })}
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
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={workflowCopy("rankingPeriod")}>
          <NativeSelect
            fieldSize="sm"
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
            <option value="day">{workflowCopy("period24Hours")}</option>
            <option value="week">{workflowCopy("period7Days")}</option>
            <option value="month">{workflowCopy("period30Days")}</option>
            <option value="year">{workflowCopy("periodAnnual")}</option>
          </NativeSelect>
        </Field>
        {value.period === "year" ? (
          <Field label={workflowCopy("rankingYear")}>
            <Input
              fieldSize="sm"
              type="number"
              min={2000}
              max={new Date().getUTCFullYear()}
              value={value.year}
              onChange={(event) => onChange({ ...value, year: Number(event.target.value) })}
            />
          </Field>
        ) : (
          <Field label={workflowCopy("releaseWindow")}>
            <NativeSelect
              fieldSize="sm"
              value={value.releaseWindow}
              onChange={(event) => onChange({ ...value, releaseWindow: event.target.value === "30d" ? "30d" : "" })}
            >
              <option value="30d">{workflowCopy("releasedIn30Days")}</option>
              <option value="">{workflowCopy("allReleases")}</option>
            </NativeSelect>
          </Field>
        )}
        <TagTemplateField
          id="dlsite-trigger-tag-template"
          enabled={!value.skipTag}
          onEnabledChange={(enabled) => onChange({ ...value, skipTag: !enabled })}
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
  row = false,
  enabled = true,
  onEnabledChange,
  onChange,
}: {
  id: string;
  value: string;
  defaultValue: string;
  tokens: WorkflowTagTemplateToken[];
  preview: WorkflowTagTemplatePreview;
  error?: string;
  spanColumns?: boolean;
  /** Render as a label-beside-control option row instead of a stacked field. */
  row?: boolean;
  /** When turned off the run adds no tag; the template stays ready to turn back on. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
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

  const toggle = onEnabledChange && (
    <SwitchControl
      label={workflowCopy("tagCollectedWorks")}
      description={workflowCopy("tagCollectedWorks")}
      checked={enabled}
      onCheckedChange={onEnabledChange}
    />
  );
  const body = enabled && (
    <div className="grid min-w-0 max-w-2xl gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Input
          ref={inputRef}
          id={id}
          fieldSize="sm"
          className="min-w-0 flex-1 font-mono"
          value={value}
          maxLength={TAG_TEMPLATE_MAX_LENGTH}
          aria-label={row ? workflowCopy("tagTemplate") : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          disabled={value === defaultValue}
          onClick={() => onChange(defaultValue)}
          title={workflowCopy("resetTagTemplate")}
          aria-label={workflowCopy("resetTagTemplate")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label={workflowCopy("availableVariables")} role="group">
        {tokens.map((token) => (
          <button
            key={token.name}
            type="button"
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => insertToken(token.name)}
            title={`${token.description} · ${workflowCopy("insertTemplatePlaceholder", { placeholder: `{${token.name}}` })}`}
          >
            <code className="font-semibold text-primary">{`{${token.name}}`}</code>
            <span className="min-w-0 truncate font-mono text-muted-foreground">{token.value || "-"}</span>
          </button>
        ))}
      </div>

      <div className="flex min-w-0 items-baseline gap-3 rounded-md bg-muted/50 px-3 py-2 text-xs" aria-live="polite">
        <span className="shrink-0 text-muted-foreground">{workflowCopy("preview")}</span>
        <code className="min-w-0 flex-1 break-all text-foreground">{preview.value || "-"}</code>
        <span
          className={`shrink-0 tabular-nums ${preview.truncated ? "text-warning-foreground" : "text-muted-foreground"}`}
        >
          {Math.min(preview.renderedLength, TAG_NAME_MAX_LENGTH)}/{TAG_NAME_MAX_LENGTH}
        </span>
      </div>
      {preview.truncated && (
        <p className="text-xs text-warning-foreground">
          {workflowCopy("tagTemplateTruncated", { count: TAG_NAME_MAX_LENGTH })}
        </p>
      )}
      {error && (
        <p className="text-xs text-error-foreground" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  if (row) {
    return (
      <div data-testid={`${id}-field`}>
        <OptionField label={workflowCopy("tagTemplate")}>
          {toggle}
          {body}
        </OptionField>
      </div>
    );
  }
  return (
    <div
      className={`grid min-w-0 content-start gap-2 ${spanColumns ? "md:col-span-2" : ""}`}
      data-testid={`${id}-field`}
    >
      <label className="flex min-h-7 items-center gap-1.5 text-sm font-medium" htmlFor={enabled ? id : undefined}>
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        {workflowCopy("tagTemplate")}
      </label>
      {toggle}
      {body}
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

function Modal({
  title,
  children,
  onClose,
  dismissible = false,
  anchorRef,
  popoverClassName,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  popoverClassName?: string;
}) {
  if (anchorRef) {
    return (
      <AnchoredPopover
        open
        anchorRef={anchorRef}
        ariaLabel={title}
        className={`${popoverClassName ?? "w-[min(42rem,calc(100vw-1.5rem))]"} p-0`}
        floatingLayer
        dismissOnOutsidePointer={dismissible}
        onOpenChange={(open) => {
          if (!open && dismissible) onClose();
        }}
      >
        <DialogHeader title={title} onClose={onClose} closeLabel={workflowCopy("close")} />
        <div className="app-scrollbar max-h-[min(70dvh,42rem)] overflow-y-auto px-5 py-4">{children}</div>
      </AnchoredPopover>
    );
  }
  return (
    <Dialog onClose={onClose} size="xl" dismissible={dismissible} className="max-w-3xl">
      <DialogHeader title={title} onClose={onClose} closeLabel={workflowCopy("close")} />
      <DialogBody>{children}</DialogBody>
    </Dialog>
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
      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
        {cancellable && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (destructiveCleanup) setConfirmingCancel(true);
              else void cancel();
            }}
          >
            {workflowCopy("cancel")}
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
            {workflowCopy("retry")}
          </Button>
        )}
      </div>
      {confirmingCancel &&
        // Portaled: the Activity popover's backdrop-filter would otherwise contain this fixed overlay.
        createPortal(
          <Dialog onClose={() => setConfirmingCancel(false)} size="md" dismissible={false}>
            <DialogHeader
              title={workflowCopy("cancelDeletionTitle")}
              onClose={() => setConfirmingCancel(false)}
              closeLabel={workflowCopy("close")}
            >
              <p className="mt-2 text-sm text-muted-foreground">{workflowCopy("cancelDeletionDescription")}</p>
              {run.workflowCode === "media_cleanup_forget_work" && (
                <p className="mt-2 text-sm text-muted-foreground">{workflowCopy("forgetStepSkipped")}</p>
              )}
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmingCancel(false)}>
                {workflowCopy("keepRunning")}
              </Button>
              <Button variant="destructive" onClick={() => void cancel()}>
                {workflowCopy("cancelWorkflow")}
              </Button>
            </DialogFooter>
          </Dialog>,
          document.body,
        )}
    </>
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
    const parsed = JSON.parse(definitionJson) as { nodes?: unknown } | null;
    if (!Array.isArray(parsed?.nodes)) return [];
    return parsed.nodes.flatMap((node): WorkflowNode[] => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return [];
      const { id, type, displayName, config } = node as Record<string, unknown>;
      if (typeof id !== "string" || !id || typeof type !== "string" || !type) return [];
      return [
        {
          id,
          type,
          ...(typeof displayName === "string" && displayName ? { displayName } : {}),
          ...(config && typeof config === "object" && !Array.isArray(config)
            ? { config: config as Record<string, unknown> }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
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

function openRemoteSourceConfiguration(sourceID: number) {
  const search = new URLSearchParams({ tab: "library", source: String(sourceID) });
  window.history.pushState({}, "", `/settings?${search}`);
  window.dispatchEvent(new Event("kikoto:navigation"));
}

function openRemoteSourcesSettings() {
  window.history.pushState({}, "", "/settings?tab=library#remote-sources");
  window.dispatchEvent(new Event("kikoto:navigation"));
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

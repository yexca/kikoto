import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { AvailabilityWatchPanel } from "@/features/workflows/availability-watch/AvailabilityWatchPanel";
import { RunDetail } from "@/features/workflows/RunDetail";
import { isDemoShowcaseActiveRun } from "@/features/workflows/runPresentation";
import { TriggerModal } from "@/features/workflows/triggers/TriggerModal";
import { useWorkflowActivityLocation } from "@/features/workflows/useWorkflowActivityLocation";
import { WorkflowActivity } from "@/features/workflows/WorkflowActivity";
import { WorkflowDetail } from "@/features/workflows/WorkflowDetail";
import {
  WorkflowCategoryRail,
  workflowCategoryPanelId,
  workflowCategoryTabId,
} from "@/features/workflows/WorkflowCategoryRail";
import {
  groupWorkflowDefinitions,
  workflowCategory,
  type WorkflowCategory,
  type WorkflowCategoryView,
} from "@/features/workflows/workflowCategories";
import { WorkflowNavigation, builtInWorkflowOrder } from "@/features/workflows/WorkflowNavigation";
import {
  configurableSystemWorkflowCodes,
  manuallyRunnableSystemWorkflows,
  readOnlySystemWorkflowCodes,
  workflowCopy,
  type CurrentTriggerRunOptions,
  type DLsitePopularRunOptions,
  type LocalScanMode,
  type RemotePopularRunOptions,
  type SystemRunKind,
  type SystemRunOptions,
} from "@/features/workflows/workflowPageModel";
import { WorkflowMetadataErrorState, WorkflowMetadataLoadingState } from "@/features/workflows/WorkflowPanelParts";
import { WorkflowRunSlotProvider, WorkflowRunSlotTarget } from "@/features/workflows/WorkflowRunSlot";
import type { CreatableAutomationTriggerType } from "@/features/workflows/workflowTriggerModel";
import { useStableCallback } from "@/hooks/useStableCallback";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import {
  api,
  type MetadataSyncOptions,
  type WorkflowDefinition,
  type WorkflowPreset,
  type WorkflowRun,
  type WorkflowTrigger,
} from "@/lib/api";
import { currentScopedStorageKey } from "@/lib/clientStorageScope";

// The editor is bound to the workflow and run options shown when it opened, not to a tab selected later.
type TriggerEditorState =
  | {
      mode: "create";
      definitionId: number;
      triggerType: CreatableAutomationTriggerType;
      runOptions: CurrentTriggerRunOptions | null;
    }
  | { mode: "edit"; definitionId: number; trigger: WorkflowTrigger; runOptions: CurrentTriggerRunOptions | null }
  | null;

const workflowDefinitionStorageBaseKey = "kikoto.workflows.definition:v3";
const workflowAllCategoriesStorageBaseKey = "kikoto.workflows.all-categories:v1";

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
  const activityRun = useWorkflowRunWatcher(activityLocation.open ? activityLocation.runId : null, !auth.demoMode);
  const linkedRun = activityRun.run?.id === activityLocation.runId ? activityRun.run : null;
  const linkedCode = linkedRun?.workflowCode || activityLocation.workflowCode || "";
  const [activityRevision, setActivityRevision] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [presets, setPresets] = useState<WorkflowPreset[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionID] = useState<number | null>(() =>
    storedPositiveInt(workflowDefinitionStorageKey),
  );
  const workflowAllCategoriesStorageKey = currentScopedStorageKey(
    workflowAllCategoriesStorageBaseKey,
    auth.user?.id ?? null,
  );
  const [showAllCategories, setShowAllCategories] = useState(
    () => readSessionValue(workflowAllCategoriesStorageKey) === "1",
  );
  const [triggerEditor, setTriggerEditor] = useState<TriggerEditorState>(null);
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

  // The location object and its actions are rebuilt on every render; only the codes decide whether to resolve.
  const linkedRunCode = linkedRun?.workflowCode;
  const locationWorkflowCode = activityLocation.workflowCode;
  const resolveActivityWorkflow = useStableCallback(activityLocation.resolveWorkflow);
  useEffect(() => {
    if (linkedRunCode !== undefined && linkedRunCode !== locationWorkflowCode) {
      resolveActivityWorkflow(linkedRunCode);
    }
  }, [linkedRunCode, locationWorkflowCode, resolveActivityWorkflow]);

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
          readOnlySystemWorkflowCodes.has(definition.code) ||
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

  const categoryGroups = useMemo(() => groupWorkflowDefinitions(visibleDefinitions), [visibleDefinitions]);
  const selectedCategory = selectedDefinition ? workflowCategory(selectedDefinition.code) : null;
  // All lists every visible workflow; otherwise the category follows the selected workflow.
  const selectedCategoryView: WorkflowCategoryView | null = showAllCategories ? "all" : selectedCategory;
  const categoryDefinitions = showAllCategories
    ? visibleDefinitions
    : (categoryGroups.find((group) => group.category === selectedCategory)?.definitions ?? visibleDefinitions);
  // Returning to a category reopens the workflow last selected in it during this visit.
  const lastDefinitionByCategory = useRef(new Map<WorkflowCategory, number>());
  useEffect(() => {
    if (selectedDefinition && selectedCategory) {
      lastDefinitionByCategory.current.set(selectedCategory, selectedDefinition.id);
    }
  }, [selectedCategory, selectedDefinition]);

  useEffect(() => {
    if (!linkedCode) return;
    const linked = visibleDefinitions.find((definition) => definition.code === linkedCode);
    if (!linked) return;
    setSelectedDefinitionID(linked.id);
    storePositiveInt(workflowDefinitionStorageKey, linked.id);
  }, [linkedCode, visibleDefinitions, workflowDefinitionStorageKey]);

  const refreshRecentRuns = useCallback((workflowCode: string) => {
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
  }, []);

  // Recent runs follow the selected workflow's code, not the definition object's identity.
  const selectedCode = selectedDefinition?.code;
  useEffect(() => {
    setRecentDefinitionRuns([]);
    if (!selectedCode) return;
    void refreshRecentRuns(selectedCode);
    return () => {
      recentRunsRequestSeq.current += 1;
    };
  }, [refreshRecentRuns, selectedCode]);

  const hasActiveRecentRun = recentDefinitionRuns.some(
    (run) => (run.status === "queued" || run.status === "running") && !isDemoShowcaseActiveRun(run),
  );
  useEffect(() => {
    if (!selectedCode || !hasActiveRecentRun) return;
    // A hidden tab skips ticks and catches up as soon as it is shown again.
    const poll = () => {
      if (!document.hidden) void refreshRecentRuns(selectedCode);
    };
    const timer = window.setInterval(poll, 2000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [hasActiveRecentRun, refreshRecentRuns, selectedCode]);

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
  const selectCategory = (category: WorkflowCategoryView) => {
    const all = category === "all";
    setShowAllCategories(all);
    storeSessionValue(workflowAllCategoriesStorageKey, all ? "1" : null);
    if (all) return;
    const group = categoryGroups.find((item) => item.category === category);
    if (!group) return;
    const rememberedId = lastDefinitionByCategory.current.get(category);
    selectDefinition(group.definitions.find((definition) => definition.id === rememberedId) ?? group.definitions[0]);
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

  const runLocalMediaIndex = async (mode: LocalScanMode) => {
    setRunningSystemAction("local_media_index");
    try {
      await api.runLocalMediaIndex({ mode });
      void refreshRecentRuns("local_media_index");
      showQueuedRun();
    } catch (error) {
      toast.notify(toastFromError(error, workflowCopy("localMediaIndexCreateFailed")));
    } finally {
      setRunningSystemAction(null);
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
    if (kind === "local_media_index") return runLocalMediaIndex(options.localMediaIndexMode ?? "incremental");
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
    if (kind === "local_scan" || kind === "local_media_index" || kind === "metadata_sync")
      return canRun && canSyncMetadata;
    if (kind === "dlsite_popular") return canRun && canSyncMetadata && canTagWorks;
    if (kind === "remote_popular") return canRun && canTagWorks && remoteSourceAvailability !== "unavailable";
    // Follow runs refresh catalogs and sync metadata; the optional tag checks tags:write itself.
    if (kind === "preset") return canRun && canSyncMetadata;
    return canRun;
  };

  const createAutomationTrigger = (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => {
    if (!selectedDefinition) return;
    triggerAnchorRef.current = anchor ?? null;
    setTriggerEditor({
      mode: "create",
      definitionId: selectedDefinition.id,
      triggerType,
      runOptions: currentTriggerRunOptions,
    });
  };

  const editAutomationTrigger = (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => {
    triggerAnchorRef.current = anchor ?? null;
    setTriggerEditor({
      mode: "edit",
      definitionId: trigger.workflowDefinitionId,
      trigger,
      runOptions: currentTriggerRunOptions,
    });
  };

  const closeTriggerEditor = () => {
    triggerAnchorRef.current = null;
    setTriggerEditor(null);
  };
  // A definition that disappears after a refresh closes its editor instead of retargeting it.
  const triggerEditorDefinition = triggerEditor
    ? (definitions.find((definition) => definition.id === triggerEditor.definitionId) ?? null)
    : null;
  const triggerEditorRunOptions =
    triggerEditor && triggerEditor.runOptions?.code === triggerEditorDefinition?.code ? triggerEditor.runOptions : null;

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
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:gap-4">
          {categoryGroups.length > 0 && (
            <WorkflowCategoryRail groups={categoryGroups} selected={selectedCategoryView} onSelect={selectCategory} />
          )}
          <div
            id={workflowCategoryPanelId}
            role={selectedCategoryView ? "tabpanel" : undefined}
            aria-labelledby={selectedCategoryView ? workflowCategoryTabId(selectedCategoryView) : undefined}
            className="min-w-0 flex-1 space-y-4"
          >
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
                    staticDemo={auth.demoMode}
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
              definitions={categoryDefinitions}
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
        </div>
      </WorkflowRunSlotProvider>

      {triggerEditor && triggerEditorDefinition && (
        <TriggerModal
          key={
            triggerEditor.mode === "edit" ? `edit:${triggerEditor.trigger.id}` : `create:${triggerEditorDefinition.id}`
          }
          definition={triggerEditorDefinition}
          preset={presetByCode.get(triggerEditorDefinition.code) ?? null}
          canTag={canTagWorks}
          trigger={triggerEditor.mode === "edit" ? triggerEditor.trigger : null}
          readOnly={triggerEditor.mode === "edit" ? readOnly : undefined}
          initialTriggerType={
            triggerEditor.mode === "create"
              ? triggerEditor.triggerType
              : triggerEditor.trigger.triggerType === "startup"
                ? "startup"
                : "schedule"
          }
          currentRunOptions={triggerEditorRunOptions}
          anchorRef={triggerAnchorRef}
          onClose={closeTriggerEditor}
          onSaved={() => {
            closeTriggerEditor();
            refresh();
          }}
          onDeleted={() => {
            closeTriggerEditor();
            refresh();
          }}
        />
      )}
    </div>
  );
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

function openRemoteSourcesSettings() {
  window.history.pushState({}, "", "/settings?tab=library#remote-sources");
  window.dispatchEvent(new Event("kikoto:navigation"));
}

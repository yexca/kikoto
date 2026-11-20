import { ChevronDown, Clapperboard, Compass } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { usePageHeaderBack } from "@/app/pageHeader";
import { useAuth } from "@/auth/AuthProvider";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { contentPageClassName } from "@/components/ui/page-width";
import { toastFromError, useToast } from "@/components/ui/toast";
import { metadataSyncSources } from "@/features/workflows/metadataSyncModel";
import { MetadataOptionsDialog } from "@/features/workflows/operations/MetadataOptionsDialog";
import {
  metadataRunOptionsChanged,
  metadataRunPayload,
  readMetadataRunOptions,
  usableMetadataRunOptions,
  writeMetadataRunOptions,
  type MetadataRunOptions,
} from "@/features/workflows/operations/metadataRunOptions";
import { OperationCard } from "@/features/workflows/operations/OperationCard";
import {
  operationLocked,
  operationState,
  operationsFromDefinitions,
  type Operation,
} from "@/features/workflows/operations/operationModel";
import { useOperationRuns } from "@/features/workflows/operations/useOperationRuns";
import { RunDetail } from "@/features/workflows/RunDetail";
import { AttentionRuns, RunningRuns } from "@/features/workflows/runs/NowRuns";
import { WorkflowRuns } from "@/features/workflows/runs/WorkflowRuns";
import { NextTriggers, type NextTriggerOwner } from "@/features/workflows/triggers/NextTriggers";
import { OperationTriggersDialog } from "@/features/workflows/triggers/OperationTriggersDialog";
import { useWorkflowsLocation } from "@/features/workflows/useWorkflowsLocation";
import { openWorkflowPath } from "@/features/workflows/workflowLinks";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { WorkflowMetadataErrorState, WorkflowMetadataLoadingState } from "@/features/workflows/WorkflowPanelParts";
import { pageManagedWorkflows, workflowTriggerSummary } from "@/features/workflows/workflowTriggerModel";
import { workflowIcon } from "@/features/workflows/workflowVisuals";
import { useMetadataSyncSources } from "@/hooks/useMetadataSyncSources";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import { api, type WorkflowDefinition, type WorkflowRun, type WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { systemSettingsPath } from "@/pages/settingsPaths";

/** A run requested here that the run list has not shown yet; `runId` is null until the request answers. */
type PendingRun = { runId: number | null };

/** How long a requested run may stay unlisted before its operation stops waiting for it. */
const pendingRunTimeoutMs = 20_000;

/** Whose triggers the dialog shows, and a trigger to open straight to. */
type TriggerDialogState = { definitionId: number; editing: WorkflowTrigger | null } | null;

/**
 * Workflows: the library maintenance an administrator starts by hand, as
 * three cards (Scan, Metadata, and Index), above every workflow's runs: Now
 * holds what runs, what needs attention, and what triggers run next, and
 * History the runs that ended. One run's details open beside the list.
 */
export function WorkflowsPage({
  canRun,
  canSyncMetadata,
  readOnly = false,
}: {
  canRun: boolean;
  canSyncMetadata: boolean;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const auth = useAuth();
  const location = useWorkflowsLocation();
  const mobile = useMobileNavigationLayout();
  const operationsHeadingId = useId();
  const [revision, setRevision] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [pending, setPending] = useState<Record<string, PendingRun>>({});
  const [fullChoices, setFullChoices] = useState<Record<string, boolean>>({});
  const [triggerDialog, setTriggerDialog] = useState<TriggerDialogState>(null);
  const [metadataOptions, setMetadataOptions] = useState<MetadataRunOptions>(readMetadataRunOptions);
  const [metadataOptionsOpen, setMetadataOptionsOpen] = useState(false);
  const metadataSources = useMetadataSyncSources(canSyncMetadata);
  const capableSources = metadataSources.sources ? metadataSyncSources(metadataSources.sources) : null;
  // Sources switched off or removed since the options were saved drop out of the fallback.
  const metadataRun = usableMetadataRunOptions(metadataOptions, capableSources);
  const [isLoading, setIsLoading] = useState(true);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [loadError, setLoadError] = useState("");
  const requestSeq = useRef(0);

  const refresh = () => {
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setLoadError("");
    Promise.all([api.listWorkflowDefinitions(), api.listWorkflowTriggers()])
      .then(([nextDefinitions, nextTriggers]) => {
        if (seq !== requestSeq.current) return;
        setDefinitions(nextDefinitions);
        setTriggers(nextTriggers);
        setHasSnapshot(true);
      })
      .catch(() => {
        if (seq === requestSeq.current) setLoadError(workflowCopy("metadataLoadFailed"));
      })
      .finally(() => {
        if (seq === requestSeq.current) setIsLoading(false);
      });
  };

  useEffect(() => {
    refresh();
  }, []);

  const operations = useMemo(() => operationsFromDefinitions(definitions), [definitions]);
  const codes = useMemo(() => operations.map((operation) => operation.definition.code), [operations]);
  const runs = useOperationRuns({ codes, refreshKey: revision, staticDemo: auth.demoMode });

  // A run that starts or ends moves its trigger's next run, so Next reloads with the queue.
  const queueSignature = runs.activeRuns.map((run) => run.id).join(",");
  const lastQueue = useRef(queueSignature);
  useEffect(() => {
    if (lastQueue.current === queueSignature) return;
    lastQueue.current = queueSignature;
    api
      .listWorkflowTriggers()
      .then(setTriggers)
      .catch(() => undefined);
  }, [queueSignature]);

  // A requested run that never shows up stops holding its operation.
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    const timer = window.setTimeout(() => setPending({}), pendingRunTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const watched = useWorkflowRunWatcher(location.runId, !auth.demoMode);
  const openRun = watched.run?.id === location.runId ? watched.run : null;
  usePageHeaderBack({
    label: t("workflowActivity.backToHistory"),
    onBack: location.backToList,
    enabled: mobile && location.runId !== null,
  });
  const refreshRun = async () => {
    await watched.refresh(true);
    setRevision((value) => value + 1);
  };
  const selectRun = (run: Pick<WorkflowRun, "id">) => location.openRun(run.id);

  /**
   * Marks the operation as starting at once, then waits for the run list to
   * show the run the request created. An operation that runs per target says
   * when its new run waits behind another of its runs, which its card keeps
   * showing.
   */
  const startRun = async (operation: Operation, request: () => Promise<{ runId: number }>, failure: string) => {
    const code = operation.definition.code;
    const before = runs.statusOf(code);
    setPending((current) => ({ ...current, [code]: { runId: null } }));
    // Full applies to the run it was chosen for.
    setFullChoices((current) => ({ ...current, [code]: false }));
    try {
      const result = await request();
      setPending((current) => ({ ...current, [code]: { runId: result.runId } }));
      setRevision((value) => value + 1);
      if (!operation.exclusive && (before?.activeRuns ?? 0) > 0 && before?.currentRun?.id !== result.runId)
        toast.notify({
          kind: "info",
          message: t("workflowPage.operations.queuedBehind", { id: result.runId }),
          actionLabel: t("workflowPage.viewRun"),
          onAction: () => selectRun({ id: result.runId }),
        });
    } catch (error) {
      setPending((current) => {
        const next = { ...current };
        delete next[code];
        return next;
      });
      toast.notify(toastFromError(error, failure));
    }
  };

  const runOperation = (operation: Operation, full: boolean) => {
    if (operation.kind === "local_scan")
      return startRun(operation, () => api.runLocalScan({ followUpRun: false }), workflowCopy("localScanCreateFailed"));
    if (operation.kind === "local_media_index")
      return startRun(
        operation,
        () => api.runLocalMediaIndex({ mode: full ? "full" : "incremental" }),
        workflowCopy("localMediaIndexCreateFailed"),
      );
    return startRun(
      operation,
      () => api.runDLsiteSync(metadataRunPayload(metadataRun, full)),
      workflowCopy("metadataSyncCreateFailed"),
    );
  };

  /** Every operation scans or syncs the library, so starting or scheduling one needs `metadata:sync`. */
  const permitted = !readOnly && canRun && canSyncMetadata;

  const toggleTrigger = async (trigger: WorkflowTrigger, enabled: boolean) => {
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
      // The operation's next run moves with its triggers.
      setRevision((value) => value + 1);
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

  const cardName = (operation: Operation) =>
    t(`workflowPage.cards.names.${operation.definition.code}`, { defaultValue: operation.definition.displayName });
  const workflowName = (code: string, fallback: string) =>
    t(`workflowPage.builtInDefinitions.${code}.name`, { defaultValue: fallback });
  const definitionsById = useMemo(
    () => new Map(definitions.map((definition) => [definition.id, definition])),
    [definitions],
  );
  const triggerOwner = (trigger: WorkflowTrigger): NextTriggerOwner => {
    const operation = operations.find((item) => item.definition.id === trigger.workflowDefinitionId);
    if (operation) return { name: cardName(operation), editable: true, path: null };
    const definition = definitionsById.get(trigger.workflowDefinitionId);
    const code = definition?.code ?? trigger.workflowCode;
    const managedPage = pageManagedWorkflows[code];
    return {
      name: workflowName(code, definition?.displayName ?? code),
      editable: false,
      path:
        managedPage && (managedPage.page !== "records" || auth.recordEnabled)
          ? managedPage.path
          : code === "source_presence_check"
            ? systemSettingsPath("library")
            : null,
    };
  };
  const dialogOperation = triggerDialog
    ? operations.find((operation) => operation.definition.id === triggerDialog.definitionId)
    : undefined;

  const workflowOptions = definitions
    .map((definition) => ({ code: definition.code, name: workflowName(definition.code, definition.displayName) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const pageManaged = pageManagedWorkflows[location.workflowCode];
  // A turned-off Record has no page to send its scans' history to.
  const managed = pageManaged?.page === "records" && !auth.recordEnabled ? undefined : pageManaged;

  const renderCard = (operation: Operation) => {
    const { definition } = operation;
    const code = definition.code;
    const status = runs.statusOf(code);
    // A requested run is listed once it is the newest run, even while the card follows an older running one.
    const requested = pending[code];
    const listed = requested?.runId != null && (status?.latestRun?.id ?? 0) >= requested.runId;
    const state = operationState(status, listed ? undefined : requested);
    const locked = operationLocked(operation, state);
    const full = fullChoices[code] ?? false;
    return (
      <OperationCard
        key={definition.id}
        code={code}
        icon={workflowIcon(code)}
        name={cardName(operation)}
        schedule={workflowTriggerSummary(
          triggers.filter((trigger) => trigger.workflowDefinitionId === definition.id),
          status?.nextRunAt ?? null,
        )}
        state={state}
        moreActive={Math.max(0, (status?.activeRuns ?? 0) - 1)}
        stageCount={status?.stageCount ?? 0}
        locked={locked}
        runAllowed={permitted}
        runBlockedReason={permitted ? undefined : t("permissions.permissionDenied")}
        full={
          operation.kind === "local_scan"
            ? null
            : {
                checked: full,
                hint: t(`workflowPage.cards.fullHint.${code}`),
                onChange: (checked) => setFullChoices((current) => ({ ...current, [code]: checked })),
              }
        }
        triggers={{
          label: t("workflowPage.triggers.title", { name: cardName(operation) }),
          onOpen:
            permitted || readOnly ? () => setTriggerDialog({ definitionId: definition.id, editing: null }) : undefined,
        }}
        options={
          operation.kind === "metadata_sync"
            ? {
                label: t("workflowPage.cards.metadataOptions"),
                summary: metadataOptionsSummary(),
                onOpen: () => setMetadataOptionsOpen(true),
              }
            : undefined
        }
        onRun={() => void runOperation(operation, full)}
        onOpenRun={selectRun}
      />
    );
  };

  /** What the Metadata card's runs change from the defaults, in one line. */
  const metadataOptionsSummary = () => {
    if (!metadataRunOptionsChanged(metadataRun)) return null;
    const names = new Map((capableSources ?? []).map((source) => [source.id, source.displayName]));
    const fallback = metadataRun.remoteMetadataFallback;
    return [
      fallback.enabled
        ? t("workflowPage.cards.fallbackSummary", {
            sources: fallback.sourceIds.map((id) => names.get(id) ?? `#${id}`).join(" → "),
          })
        : null,
      metadataRun.purchaseBonusAutoLink ? null : t("workflowPage.cards.bonusOff"),
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const runOpen = location.runId !== null;
  // Library folds while a run is open and opens again with the list; a choice in between holds until then.
  const [libraryChoice, setLibraryChoice] = useState<{ runOpen: boolean; open: boolean | null }>({
    runOpen,
    open: null,
  });
  if (libraryChoice.runOpen !== runOpen) setLibraryChoice({ runOpen, open: null });
  const libraryOpen = (libraryChoice.runOpen === runOpen ? libraryChoice.open : null) ?? !runOpen;

  return (
    <div className={cn(contentPageClassName, "space-y-8")}>
      {readOnly && <DemoReadOnlyNotice />}
      {hasSnapshot && loadError && (
        <div
          className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2"
          role="alert"
        >
          <span className="text-sm text-error-foreground">
            {loadError} {t("workflow.existingDataShown")}
          </span>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      <section aria-labelledby={operationsHeadingId} className="min-w-0 space-y-3">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <h2 id={operationsHeadingId} className="text-base font-semibold">
            <button
              type="button"
              className="-ml-1 flex items-center gap-1.5 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={libraryOpen}
              aria-controls={`${operationsHeadingId}-cards`}
              onClick={() => setLibraryChoice({ runOpen, open: !libraryOpen })}
            >
              {t("workflowPage.operations.groups.library")}
              <ChevronDown
                className={cn("h-4 w-4 text-muted-foreground transition-transform", !libraryOpen && "-rotate-90")}
                aria-hidden
              />
            </button>
          </h2>
        </div>
        <div id={`${operationsHeadingId}-cards`} hidden={!libraryOpen}>
          {!libraryOpen ? null : !hasSnapshot && isLoading ? (
            <WorkflowMetadataLoadingState />
          ) : !hasSnapshot && loadError ? (
            <WorkflowMetadataErrorState message={loadError} onRetry={refresh} />
          ) : operations.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{workflowCopy("definitionEmpty")}</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-3">{operations.map(renderCard)}</ul>
          )}
        </div>
      </section>
      <WorkflowRuns
        tab={location.tab}
        onTabChange={location.setTab}
        nowCount={runs.running + runs.attention}
        now={
          <div className="grid min-w-0 gap-6">
            <RunningRuns
              runs={runs.activeRuns}
              total={runs.running}
              selectedRunId={location.runId}
              canSyncMetadata={canSyncMetadata}
              onSelectRun={selectRun}
            />
            <AttentionRuns
              refreshKey={revision}
              staticDemo={auth.demoMode}
              readOnly={readOnly}
              canSyncMetadata={canSyncMetadata}
              selectedRunId={location.runId}
              onSelectRun={selectRun}
              onChanged={() => setRevision((value) => value + 1)}
            />
            <NextTriggers
              triggers={triggers}
              ownerOf={triggerOwner}
              canManage={permitted}
              readOnly={readOnly}
              loading={!hasSnapshot && isLoading}
              onToggle={(trigger, enabled) => void toggleTrigger(trigger, enabled)}
              onEdit={(trigger) => setTriggerDialog({ definitionId: trigger.workflowDefinitionId, editing: trigger })}
              onOpenPath={openWorkflowPath}
            />
          </div>
        }
        status={location.status}
        onStatusChange={location.setStatus}
        workflowCode={location.workflowCode}
        workflowOptions={workflowOptions}
        onWorkflowChange={location.setWorkflow}
        query={location.query}
        onQueryChange={location.setQuery}
        note={
          managed ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <p className="min-w-0">{workflowCopy(managed.message)}</p>
              <Button size="sm" variant="outline" onClick={() => openWorkflowPath(managed.path)}>
                {managed.page === "records" ? <Clapperboard className="h-4 w-4" /> : <Compass className="h-4 w-4" />}
                {workflowCopy(managed.page === "records" ? "openRecords" : "openSubscriptions")}
              </Button>
            </div>
          ) : undefined
        }
        selectedRunId={location.runId}
        onSelectRun={selectRun}
        onBack={location.backToList}
        refreshKey={revision}
        staticDemo={auth.demoMode}
        canSyncMetadata={canSyncMetadata}
        mobile={mobile}
        detail={
          location.runId ? (
            <>
              {watched.error && (
                <div role="alert" className="mb-4 rounded-md border p-3 text-sm">
                  {workflowCopy("activityLoadFailed")}{" "}
                  <Button variant="outline" onClick={() => void watched.refresh(true)}>
                    {t("common.retry")}
                  </Button>
                </div>
              )}
              <RunDetail
                key={location.runId}
                run={openRun}
                candidates={openRun ? watched.candidates : []}
                events={openRun ? watched.events : []}
                loading={!openRun && !watched.error}
                onCandidateUpdate={refreshRun}
                onRunAction={refreshRun}
                canSyncMetadata={canSyncMetadata}
                readOnly={readOnly}
              />
            </>
          ) : undefined
        }
      />
      {metadataOptionsOpen && (
        <MetadataOptionsDialog
          value={metadataRun}
          sources={capableSources}
          sourcesFailed={metadataSources.failed}
          readOnly={readOnly || !permitted}
          onRetrySources={metadataSources.retry}
          onSave={(next) => {
            setMetadataOptions(next);
            writeMetadataRunOptions(next);
            setMetadataOptionsOpen(false);
          }}
          onClose={() => setMetadataOptionsOpen(false)}
        />
      )}
      {dialogOperation && (
        <OperationTriggersDialog
          operation={{ definition: dialogOperation.definition, name: cardName(dialogOperation) }}
          triggers={triggers.filter((trigger) => trigger.workflowDefinitionId === dialogOperation.definition.id)}
          editing={triggerDialog?.editing}
          canManage={permitted}
          readOnly={readOnly}
          metadataConfigJson={JSON.stringify(metadataRunPayload(metadataRun, false))}
          onToggle={(trigger, enabled) => void toggleTrigger(trigger, enabled)}
          onChanged={() => {
            refresh();
            setRevision((value) => value + 1);
          }}
          onClose={() => setTriggerDialog(null)}
        />
      )}
    </div>
  );
}

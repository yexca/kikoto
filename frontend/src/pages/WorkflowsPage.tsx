import { TriangleAlert } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { Button } from "@/components/ui/button";
import { contentPageClassName } from "@/components/ui/page-width";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  groupOperations,
  operationLocked,
  operationState,
  operationsFromDefinitions,
  type Operation,
  type OperationGroupEntry,
} from "@/features/workflows/operations/operationModel";
import { OperationPanel } from "@/features/workflows/operations/OperationPanel";
import { OperationRow } from "@/features/workflows/operations/OperationRow";
import { useOperationRuns } from "@/features/workflows/operations/useOperationRuns";
import { TriggerModal } from "@/features/workflows/triggers/TriggerModal";
import {
  activityPath,
  openWorkflowPath,
  OPERATIONS_PATH,
  workflowActivityRunPath,
} from "@/features/workflows/workflowLinks";
import {
  parseNodes,
  workflowCopy,
  type CurrentTriggerRunOptions,
  type SystemRunOptions,
} from "@/features/workflows/workflowPageModel";
import { WorkflowMetadataErrorState, WorkflowMetadataLoadingState } from "@/features/workflows/WorkflowPanelParts";
import { workflowTriggerSummary, type CreatableAutomationTriggerType } from "@/features/workflows/workflowTriggerModel";
import { workflowIcon } from "@/features/workflows/workflowVisuals";
import { api, type WorkflowDefinition, type WorkflowRun, type WorkflowTrigger } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";

// The editor is bound to the operation and run options shown when it opened, not to one opened later.
type TriggerEditorState =
  | {
      mode: "create";
      definitionId: number;
      triggerType: CreatableAutomationTriggerType;
      runOptions: CurrentTriggerRunOptions | null;
    }
  | { mode: "edit"; definitionId: number; trigger: WorkflowTrigger; runOptions: CurrentTriggerRunOptions | null }
  | null;

/** A run requested here that the run list has not shown yet; `runId` is null until the request answers. */
type PendingRun = { runId: number | null };

/** How long a requested run may stay unlisted before its operation stops waiting for it. */
const pendingRunTimeoutMs = 20_000;

function openCodeFromLocation() {
  return new URLSearchParams(window.location.search).get("workflow")?.trim() ?? "";
}

/**
 * Workflows: what an administrator starts by hand, grouped by what it is
 * for. An operation shows its state and one run control; its options,
 * triggers, and run history open below it. Every run is in Activity.
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
  const [revision, setRevision] = useState(0);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [openCode, setOpenCode] = useState(openCodeFromLocation);
  const [pending, setPending] = useState<Record<string, PendingRun>>({});
  const [triggerEditor, setTriggerEditor] = useState<TriggerEditorState>(null);
  const triggerAnchorRef = useRef<HTMLElement | null>(null);
  const [currentTriggerRunOptions, setCurrentTriggerRunOptions] = useState<CurrentTriggerRunOptions | null>(null);
  const [isWorkflowMetaLoading, setIsWorkflowMetaLoading] = useState(true);
  const [hasWorkflowMetaSnapshot, setHasWorkflowMetaSnapshot] = useState(false);
  const [workflowMetaError, setWorkflowMetaError] = useState("");
  const workflowMetaRequestSeq = useRef(0);

  const refresh = () => {
    const seq = ++workflowMetaRequestSeq.current;
    setIsWorkflowMetaLoading(true);
    setWorkflowMetaError("");
    Promise.all([api.listWorkflowDefinitions(), api.listWorkflowTriggers()])
      .then(([nextDefinitions, nextTriggers]) => {
        if (seq !== workflowMetaRequestSeq.current) return;
        setDefinitions(nextDefinitions);
        setTriggers(nextTriggers);
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

  // The open operation is the page's linked state (`?workflow=<code>`).
  useEffect(() => {
    const sync = () => setOpenCode(openCodeFromLocation());
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const operations = useMemo(() => operationsFromDefinitions(definitions), [definitions]);
  const groups = useMemo(() => groupOperations(operations), [operations]);
  const codes = useMemo(() => operations.map((operation) => operation.definition.code), [operations]);
  const runs = useOperationRuns({ codes, refreshKey: revision, staticDemo: auth.demoMode });
  const openOperation = operations.find((operation) => operation.definition.code === openCode) ?? null;

  // A link to a workflow that is not an operation leads to its runs in Activity; an unknown code is dropped.
  useEffect(() => {
    if (!openCode || !hasWorkflowMetaSnapshot || openOperation) return;
    const known = definitions.some((definition) => definition.code === openCode);
    window.history.replaceState(
      window.history.state,
      "",
      known ? activityPath({ workflow: openCode }) : OPERATIONS_PATH,
    );
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  }, [definitions, hasWorkflowMetaSnapshot, openCode, openOperation]);

  const toggleOperation = (code: string, open: boolean) => {
    window.history.replaceState(
      window.history.state,
      "",
      open ? `${OPERATIONS_PATH}?${new URLSearchParams({ workflow: code })}` : OPERATIONS_PATH,
    );
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const openOperationCode = openOperation?.definition.code;

  // A requested run that never shows up stops holding its operation.
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    const timer = window.setTimeout(() => setPending({}), pendingRunTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const openActivityRun = (run: Pick<WorkflowRun, "id">) => openWorkflowPath(workflowActivityRunPath(run.id));

  /**
   * Marks the operation as starting at once, then waits for the run list to
   * show the run the request created. An operation that runs per target says
   * when its new run waits behind another of its runs, which its row keeps
   * showing.
   */
  const startRun = async (operation: Operation, request: () => Promise<{ runId: number }>, failure: string) => {
    const code = operation.definition.code;
    const active = runs.activeRunsOf(code);
    setPending((current) => ({ ...current, [code]: { runId: null } }));
    try {
      const result = await request();
      setPending((current) => ({ ...current, [code]: { runId: result.runId } }));
      setRevision((value) => value + 1);
      if (!operation.exclusive && active.length > 0 && !active.some((run) => run.id === result.runId))
        toast.notify({
          kind: "info",
          message: t("workflowPage.operations.queuedBehind", { id: result.runId }),
          actionLabel: t("nav.activity"),
          onAction: () => openActivityRun({ id: result.runId }),
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

  const runOperation = async (operation: Operation, options: SystemRunOptions) => {
    if (operation.kind === "local_scan")
      return startRun(
        operation,
        () => api.runLocalScan({ followUpRun: options.followUpRun ?? false }),
        workflowCopy("localScanCreateFailed"),
      );
    if (operation.kind === "local_media_index")
      return startRun(
        operation,
        () => api.runLocalMediaIndex({ mode: options.localMediaIndexMode ?? "incremental" }),
        workflowCopy("localMediaIndexCreateFailed"),
      );
    if (operation.kind === "metadata_sync")
      return startRun(
        operation,
        () => api.runDLsiteSync(options.metadataSync),
        workflowCopy("metadataSyncCreateFailed"),
      );
  };

  /** Every operation scans or syncs the library, so starting, configuring, or scheduling one needs `metadata:sync`. */
  const permitted = !readOnly && canRun && canSyncMetadata;

  const createAutomationTrigger = (
    definition: WorkflowDefinition,
    triggerType: CreatableAutomationTriggerType,
    anchor?: HTMLElement | null,
  ) => {
    triggerAnchorRef.current = anchor ?? null;
    setTriggerEditor({
      mode: "create",
      definitionId: definition.id,
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

  const renderOperation = (operation: Operation) => {
    const { definition } = operation;
    const code = definition.code;
    const run = runs.runOf(code);
    const active = runs.activeRunsOf(code);
    // A requested run is listed once it is active, even while the row follows an older running one.
    const requested = pending[code];
    const listed = requested?.runId != null && active.some((item) => item.id >= (requested.runId ?? 0));
    const state = operationState(run, listed ? undefined : requested);
    const locked = operationLocked(operation, state);
    const operationTriggers = triggers.filter((trigger) => trigger.workflowDefinitionId === definition.id);
    const expanded = openOperationCode === code;
    const allowed = permitted;
    const defaults = operation.defaults;
    return (
      <OperationRow
        key={definition.id}
        code={code}
        icon={workflowIcon(code)}
        name={t(`workflowPage.builtInDefinitions.${code}.name`, { defaultValue: definition.displayName })}
        schedule={workflowTriggerSummary(operationTriggers)}
        state={state}
        moreActive={Math.max(0, active.length - 1)}
        locked={locked}
        stageCount={parseNodes(definition.definitionJson).length}
        expanded={expanded}
        runAllowed={allowed && !locked}
        runBlockedReason={permitted ? undefined : t("permissions.permissionDenied")}
        onRun={() => void runOperation(operation, defaults())}
        onToggle={(open) => toggleOperation(code, open)}
        onOpenRun={openActivityRun}
      >
        <OperationPanel
          operation={operation}
          summary={t(`workflowPage.operations.summaries.${code}`, {
            defaultValue: t(`workflowPage.builtInDefinitions.${code}.description`, {
              defaultValue: definition.description,
            }),
          })}
          state={state}
          triggers={operationTriggers}
          allowed={allowed}
          readOnly={readOnly}
          canManageTriggers={!readOnly && definition.id > 0 && permitted}
          onRun={(options) => runOperation(operation, options)}
          onTriggerRunOptionsChange={setCurrentTriggerRunOptions}
          onOpenRuns={() => openWorkflowPath(activityPath({ workflow: code }))}
          onCreateTrigger={(triggerType, anchor) => createAutomationTrigger(definition, triggerType, anchor)}
          onEditTrigger={editAutomationTrigger}
          onToggleTrigger={toggleAutomationTrigger}
        />
      </OperationRow>
    );
  };

  return (
    <div className={cn(contentPageClassName, "space-y-6")}>
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
      {runs.attention > 0 && (
        <button
          type="button"
          className="touch-target flex max-w-full items-center gap-2 rounded-md text-left text-sm text-warning-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openWorkflowPath(activityPath({ view: "attention" }))}
        >
          <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0">{t("workflowPage.console.attentionCount", { count: runs.attention })}</span>
        </button>
      )}
      {!hasWorkflowMetaSnapshot && isWorkflowMetaLoading ? (
        <WorkflowMetadataLoadingState />
      ) : !hasWorkflowMetaSnapshot && workflowMetaError ? (
        <WorkflowMetadataErrorState message={workflowMetaError} onRetry={refresh} />
      ) : groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{workflowCopy("definitionEmpty")}</p>
      ) : (
        <>
          {groups.map((entry) => (
            <OperationGroupSection key={entry.group} entry={entry} renderOperation={renderOperation} />
          ))}
          <p className="text-sm text-muted-foreground">
            <LinkedSentence
              text={(slots) => t("workflowPage.operations.elsewhere", slots)}
              links={{
                discover: <PageLink path="/discover">{t("nav.subscriptions")}</PageLink>,
                activity: <PageLink path={activityPath()}>{t("nav.activity")}</PageLink>,
              }}
            />
          </p>
        </>
      )}
      {triggerEditor && triggerEditorDefinition && (
        <TriggerModal
          key={
            triggerEditor.mode === "edit" ? `edit:${triggerEditor.trigger.id}` : `create:${triggerEditorDefinition.id}`
          }
          definition={triggerEditorDefinition}
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

/** A group of operations under a plain heading and a hairline, one row each. */
function OperationGroupSection({
  entry,
  renderOperation,
}: {
  entry: OperationGroupEntry;
  renderOperation: (operation: Operation) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h2 id={headingId} className="border-b pb-2 text-base font-semibold">
        {t(`workflowPage.operations.groups.${entry.group}`)}
      </h2>
      <ul className="divide-y">{entry.operations.map(renderOperation)}</ul>
    </section>
  );
}

/** A translated sentence whose named slots are links, wherever the language puts them. */
function LinkedSentence({
  text,
  links,
}: {
  text: (slots: Record<string, string>) => string;
  links: Record<string, React.ReactNode>;
}) {
  const mark = "\u0000";
  const names = Object.keys(links);
  const parts = text(Object.fromEntries(names.map((name) => [name, `${mark}${name}${mark}`]))).split(mark);
  // Odd parts are the slot names the marks enclosed.
  return parts.map((part, index) => <Fragment key={index}>{index % 2 === 1 ? links[part] : part}</Fragment>);
}

function PageLink({ path, children }: { path: string; children?: React.ReactNode }) {
  return (
    <a
      href={path}
      className="rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        openWorkflowPath(path);
      }}
    >
      {children}
    </a>
  );
}

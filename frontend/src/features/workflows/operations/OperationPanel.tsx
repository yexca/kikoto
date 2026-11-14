import { List } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  LocalMediaIndexRunPanel,
  LocalScanRunPanel,
  MetadataSyncRunPanel,
} from "@/features/workflows/run-forms/LibraryRunPanels";
import { RunBusyLabelContext, type RunFormLayout } from "@/features/workflows/RunOptionControls";
import { WorkflowAutomationPanel } from "@/features/workflows/triggers/WorkflowAutomationPanel";
import {
  workflowCopy,
  type CurrentTriggerRunOptions,
  type SystemRunOptions,
} from "@/features/workflows/workflowPageModel";
import {
  supportedAutomationTriggerTypes,
  type CreatableAutomationTriggerType,
} from "@/features/workflows/workflowTriggerModel";
import type { WorkflowTrigger } from "@/lib/api";

import { operationLocked, type Operation, type OperationState } from "./operationModel";

/**
 * What an operation keeps off its row: what it does with a link to its runs
 * in Activity, the options of the next run with the run bar that uses them,
 * and the triggers that start it on their own.
 */
export function OperationPanel({
  operation,
  summary,
  state,
  triggers,
  allowed,
  readOnly,
  canManageTriggers,
  onRun,
  onTriggerRunOptionsChange,
  onOpenRuns,
  onCreateTrigger,
  onEditTrigger,
  onToggleTrigger,
}: {
  operation: Operation;
  /** One sentence on what the operation does. */
  summary: string;
  state: OperationState;
  triggers: WorkflowTrigger[];
  allowed: boolean;
  /** Demo opens run forms and triggers for inspection; running and saving stay disabled. */
  readOnly: boolean;
  canManageTriggers: boolean;
  onRun: (options: SystemRunOptions) => Promise<void>;
  onTriggerRunOptionsChange: (options: CurrentTriggerRunOptions) => void;
  /** Opens Activity on this operation's runs. */
  onOpenRuns: () => void;
  onCreateTrigger: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEditTrigger: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
  onToggleTrigger: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { definition, kind } = operation;
  const running = operationLocked(operation, state);
  const busyLabel =
    state.phase === "queued"
      ? t("workflowActivity.status.queued")
      : state.phase === "running"
        ? t("workflowActivity.status.running")
        : t("workflowPage.operations.status.starting");
  // Keyed by the operation so another operation's form starts from its own defaults.
  const runForm =
    kind === "local_scan" ? (
      <LocalScanRunPanel
        key={definition.code}
        layout={operationFormLayout}
        running={running}
        allowed={allowed}
        onRun={(followUpRun) => onRun({ followUpRun })}
      />
    ) : kind === "local_media_index" ? (
      <LocalMediaIndexRunPanel
        key={definition.code}
        layout={operationFormLayout}
        running={running}
        allowed={allowed}
        onRun={(localMediaIndexMode) => onRun({ localMediaIndexMode })}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : kind === "metadata_sync" ? (
      <MetadataSyncRunPanel
        key={definition.code}
        layout={operationFormLayout}
        running={running}
        allowed={allowed}
        onRun={(metadataSync) => onRun({ metadataSync })}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : null;
  const showAutomation = supportedAutomationTriggerTypes(definition).length > 0 || triggers.length > 0;

  return (
    <div className="grid min-w-0 gap-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 flex-1 basis-60 py-1.5 text-sm text-muted-foreground">{summary}</p>
        <Button size="sm" variant="ghost" className="-mr-2 shrink-0 px-2" onClick={onOpenRuns}>
          <List className="h-4 w-4" aria-hidden />
          {t("workflowPage.operations.allRuns")}
        </Button>
      </div>
      <RunBusyLabelContext.Provider value={busyLabel}>{runForm}</RunBusyLabelContext.Provider>
      {showAutomation && (
        <WorkflowAutomationPanel
          definition={definition}
          triggers={triggers}
          canManage={canManageTriggers}
          readOnly={readOnly}
          onCreate={onCreateTrigger}
          onEdit={onEditTrigger}
          onToggle={onToggleTrigger}
        />
      )}
    </div>
  );
}

/**
 * An operation's run form: the options, then a run bar that keeps Run and the
 * reason it is unavailable beside each other and sticks to the bottom of the
 * viewport while a long form scrolls.
 */
const operationFormLayout: RunFormLayout = ({ run, actions, options, optionsActions, blocker }) => {
  const title = workflowCopy("runOptions");
  return (
    <section className="workflow-options min-w-0" aria-label={title}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {optionsActions && <div className="-mr-2 flex gap-1">{optionsActions}</div>}
      </div>
      {options && <div className="pb-4 pt-2">{options}</div>}
      {(run || actions || blocker) && (
        <RunBar blocker={blocker}>
          {actions}
          {run}
        </RunBar>
      )}
    </section>
  );
};

/** The run form's last row; it is marked stuck while it floats over the rest of a long form. */
function RunBar({ blocker, children }: { blocker?: ReactNode; children: ReactNode }) {
  const barRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const bar = barRef.current;
    const end = endRef.current;
    if (!bar || !end) return;
    // The bar floats while the form's end is still below the bar's resting line.
    const inset = Number.parseFloat(window.getComputedStyle(bar).bottom) || 0;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting && entry.boundingClientRect.top > 0),
      { rootMargin: `0px 0px -${inset}px 0px` },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        ref={barRef}
        data-stuck={stuck || undefined}
        className="workflow-run-bar flex min-h-14 items-center gap-2 border-t py-2.5"
      >
        <div className="min-w-0 flex-1">{blocker}</div>
        {children}
      </div>
      <div ref={endRef} aria-hidden className="-mt-px h-px" />
    </>
  );
}

import { AlertCircle, Settings2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  LocalMediaIndexRunPanel,
  LocalScanRunPanel,
  MetadataSyncRunPanel,
} from "@/features/workflows/run-forms/LibraryRunPanels";
import { DLsitePopularRunPanel, RemotePopularRunPanel } from "@/features/workflows/run-forms/PopularRunPanels";
import { PresetRunPanel } from "@/features/workflows/run-forms/PresetRunPanel";
import { RemoteFetchRunPanel } from "@/features/workflows/run-forms/RemoteFetchRunPanel";
import type { RunFormLayout } from "@/features/workflows/RunOptionControls";
import { isActiveRunStatus, isDemoShowcaseActiveRun } from "@/features/workflows/runPresentation";
import { WorkflowAutomationPanel } from "@/features/workflows/triggers/WorkflowAutomationPanel";
import { WorkflowDetailFrame } from "@/features/workflows/WorkflowDetailFrame";
import { RecentRunList, WorkflowSection } from "@/features/workflows/WorkflowDetailLayout";
import {
  parseNodes,
  workflowCopy,
  type CurrentTriggerRunOptions,
  type DLsitePopularRunOptions,
  type RemotePopularRunOptions,
  type RemoteFetchRunOptions,
  type SystemRunKind,
  type SystemRunOptions,
  type WorkflowNode,
} from "@/features/workflows/workflowPageModel";
import { EmptyPanel } from "@/features/workflows/WorkflowPanelParts";
import { WorkflowRunMonitor } from "@/features/workflows/WorkflowRunMonitor";
import { WorkflowRunSlotContent } from "@/features/workflows/WorkflowRunSlot";
import { workflowStages } from "@/features/workflows/workflowStageModel";
import {
  supportedAutomationTriggerTypes,
  type CreatableAutomationTriggerType,
} from "@/features/workflows/workflowTriggerModel";
import { useWorkflowRunWatcher } from "@/hooks/useWorkflowRunWatcher";
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowNodeRun,
  WorkflowPreset,
  WorkflowRun,
  WorkflowTrigger,
} from "@/lib/api";

export function WorkflowDetail({
  definition,
  definitionTriggers = [],
  canManageTriggers,
  readOnly = false,
  systemRunKinds,
  isSystemActionRunning,
  canRunSystemAction,
  onRunSystemAction,
  onRunRemotePopular,
  onRunRemoteFetch,
  onOpenRemoteSourceSettings,
  canFetchRemotePopular = false,
  canConfigureMetadataSync = false,
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
  onRunRemoteFetch?: (options: RemoteFetchRunOptions) => Promise<boolean>;
  onOpenRemoteSourceSettings?: () => void;
  canFetchRemotePopular?: boolean;
  /** Offers the metadata sync configuration, which edits instance settings. */
  canConfigureMetadataSync?: boolean;
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
  const runKind = definition.scope === "system" ? systemRunKinds?.[0] : undefined;
  const running = runKind ? (isSystemActionRunning?.(runKind) ?? false) : false;
  const allowed = runKind ? (canRunSystemAction?.(runKind) ?? false) : false;
  const layout = runFormLayout({ optionsTitle: workflowCopy("runOptions") });
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
    ) : runKind === "local_media_index" && onRunSystemAction ? (
      <LocalMediaIndexRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        onRun={(localMediaIndexMode) => onRunSystemAction("local_media_index", { localMediaIndexMode })}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
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
    ) : runKind === "remote_fetch" && onRunRemoteFetch ? (
      <RemoteFetchRunPanel
        key={definition.code}
        layout={layout}
        running={running}
        allowed={allowed}
        onRun={onRunRemoteFetch}
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
        configurable={canConfigureMetadataSync}
        readOnly={readOnly}
        onRun={(metadataSync) => onRunSystemAction("metadata_sync", { metadataSync })}
        onTriggerRunOptionsChange={onTriggerRunOptionsChange}
      />
    ) : (
      layout({ run: null, options: null })
    );
  const showAutomation =
    supportedAutomationTriggerTypes(definition, Boolean(preset)).length > 0 || definitionTriggers.length > 0;
  return (
    <WorkflowDetailFrame
      definition={definition}
      recentRuns={recentRuns}
      triggers={definitionTriggers}
      onOpenRun={onOpenRun}
    >
      <div className="workflow-detail relative min-w-0">
        <div className="grid min-w-0 gap-5">
          {runForm}
          <DefinitionRunMonitor nodes={nodes} recentRuns={recentRuns} onOpenRun={onOpenRun} />
          <div className="workflow-detail-pair">
            {showAutomation && (
              <WorkflowPanel>
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
              </WorkflowPanel>
            )}
            {onOpenRun && (
              <WorkflowPanel>
                <RecentWorkflowRuns runs={recentRuns} onOpen={onOpenRun} />
              </WorkflowPanel>
            )}
          </div>
        </div>
        {definition.code === "remote_popular_collection" && remoteSourceUnavailable && (
          <div
            className="absolute inset-0 z-10 grid place-items-center rounded-lg bg-background/80 p-6 text-center backdrop-blur-sm"
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
      </div>
    </WorkflowDetailFrame>
  );
}

/** A bordered surface for one configuration area of the selected workflow. */
export function WorkflowPanel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-w-0 rounded-lg border bg-card px-4 py-3 ${className}`}>{children}</div>;
}

/**
 * A workflow with options gets a run form: the options, then a run bar that
 * sticks to the bottom of the viewport while a long form scrolls, keeping Run
 * and the reason it is unavailable beside each other. A workflow without
 * options places Run in the header instead.
 */
export function runFormLayout({ optionsTitle }: { optionsTitle: string }): RunFormLayout {
  return ({ run, actions, options, optionsActions, blocker }) => {
    if (!options) {
      return run || actions ? (
        <WorkflowRunSlotContent>
          {actions}
          {run}
        </WorkflowRunSlotContent>
      ) : null;
    }
    return (
      <WorkflowPanel className="workflow-options pb-0">
        <section className="min-w-0" aria-label={optionsTitle}>
          <div className="flex min-h-9 items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{optionsTitle}</h4>
            {optionsActions && <div className="-mr-2 flex gap-1">{optionsActions}</div>}
          </div>
          <div className="pb-4 pt-3">{options}</div>
          {(run || actions || blocker) && (
            <RunBar blocker={blocker}>
              {actions}
              {run}
            </RunBar>
          )}
        </section>
      </WorkflowPanel>
    );
  };
}

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
        className="workflow-run-bar -mx-4 flex min-h-14 items-center gap-2 rounded-b-lg border-t px-4 py-2.5"
      >
        <div className="min-w-0 flex-1">{blocker}</div>
        {children}
      </div>
      <div ref={endRef} aria-hidden className="-mt-px h-px" />
    </>
  );
}

const emptyEvents: WorkflowEvent[] = [];
const emptyNodeRuns: WorkflowNodeRun[] = [];

/** Stages and log of the definition's most recent run; an active run streams into the log. */
export function DefinitionRunMonitor({
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
  const watched = useWorkflowRunWatcher(
    latestRun?.id ?? null,
    isActiveRunStatus(latestRun?.status ?? "") && (!latestRun || !isDemoShowcaseActiveRun(latestRun)),
  );
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

const recentRunListSize = 5;

export function RecentWorkflowRuns({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (run: WorkflowRun) => void }) {
  return (
    <WorkflowSection title={workflowCopy("recentRuns")}>
      <RecentRunList runs={runs.slice(0, recentRunListSize)} empty={workflowCopy("noRecentRuns")} onOpen={onOpen} />
    </WorkflowSection>
  );
}

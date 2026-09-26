import { AlertCircle, Settings2 } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  LocalMediaIndexRunPanel,
  LocalScanRunPanel,
  MetadataSyncRunPanel,
} from "@/features/workflows/run-forms/LibraryRunPanels";
import { DLsitePopularRunPanel, RemotePopularRunPanel } from "@/features/workflows/run-forms/PopularRunPanels";
import { PresetRunPanel } from "@/features/workflows/run-forms/PresetRunPanel";
import type { RunFormLayout } from "@/features/workflows/RunOptionControls";
import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { WorkflowAutomationPanel } from "@/features/workflows/triggers/WorkflowAutomationPanel";
import { RecentRunList, WorkflowHeader, WorkflowSection } from "@/features/workflows/WorkflowDetailLayout";
import {
  localizedWorkflowDefinition,
  parseNodes,
  workflowCopy,
  type CurrentTriggerRunOptions,
  type DLsitePopularRunOptions,
  type RemotePopularRunOptions,
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

export function runFormLayout({
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

export function RecentWorkflowRuns({ runs, onOpen }: { runs: WorkflowRun[]; onOpen: (run: WorkflowRun) => void }) {
  return (
    <WorkflowSection title={workflowCopy("recentRuns")}>
      <RecentRunList runs={runs} empty={workflowCopy("noRecentRuns")} onOpen={onOpen} />
    </WorkflowSection>
  );
}

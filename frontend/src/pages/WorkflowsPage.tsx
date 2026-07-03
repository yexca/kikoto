import { Activity, CalendarClock, Database, ListChecks, Play, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type WorkflowDefinition, type WorkflowRun, type WorkflowTrigger } from "@/lib/api";

type WorkflowView = "definitions" | "triggers" | "runs";

export function WorkflowsPage({
  initialView,
  canRun,
  canSyncMetadata,
}: {
  initialView: WorkflowView;
  canRun: boolean;
  canSyncMetadata: boolean;
}) {
  const [view, setView] = useState<WorkflowView>(initialView);
  const [definitions, setDefinitions] = useState<WorkflowDefinition[]>([]);
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [isRunningScan, setIsRunningScan] = useState(false);
  const [isSyncingMetadata, setIsSyncingMetadata] = useState(false);

  const refresh = () => {
    api.listWorkflowDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
    api.listWorkflowTriggers().then(setTriggers).catch(() => setTriggers([]));
    api.listWorkflowRuns().then(setRuns).catch(() => setRuns([]));
  };

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  useEffect(() => {
    refresh();
  }, []);

  const runLocalScan = async () => {
    setIsRunningScan(true);
    try {
      await api.runLocalScan();
      refresh();
      setView("runs");
    } finally {
      setIsRunningScan(false);
    }
  };

  const runMetadataSync = async () => {
    setIsSyncingMetadata(true);
    try {
      await api.runDLsiteSync();
      refresh();
      setView("runs");
    } finally {
      setIsSyncingMetadata(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{view === "runs" ? "Runs" : "Workflows"}</h2>
          <p className="text-sm text-muted-foreground">Triggers start definitions; runs record each modular execution.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={runLocalScan} disabled={isRunningScan || !canRun}>
            <Play className="h-4 w-4" />
            {isRunningScan ? "Running" : "Run local scan"}
          </Button>
          <Button size="sm" variant="outline" onClick={runMetadataSync} disabled={isSyncingMetadata || !canSyncMetadata}>
            <Play className="h-4 w-4" />
            {isSyncingMetadata ? "Syncing" : "Sync metadata"}
          </Button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto rounded-lg border bg-card p-1">
        <ViewButton active={view === "definitions"} onClick={() => setView("definitions")} icon={<Workflow className="h-4 w-4" />}>
          Definitions
        </ViewButton>
        <ViewButton active={view === "triggers"} onClick={() => setView("triggers")} icon={<CalendarClock className="h-4 w-4" />}>
          Triggers
        </ViewButton>
        <ViewButton active={view === "runs"} onClick={() => setView("runs")} icon={<Activity className="h-4 w-4" />}>
          Runs
        </ViewButton>
      </div>

      {view === "definitions" && <DefinitionList definitions={definitions} />}
      {view === "triggers" && <TriggerList triggers={triggers} />}
      {view === "runs" && <RunList runs={runs} />}
    </div>
  );
}

function ViewButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
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

function DefinitionList({ definitions }: { definitions: WorkflowDefinition[] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {definitions.map((definition) => (
        <Card key={definition.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold">{definition.displayName}</div>
                <p className="mt-1 text-sm text-muted-foreground">{definition.description}</p>
              </div>
              <Badge variant="outline">{definition.code}</Badge>
            </div>
            <WorkflowNodeBadges definitionJson={definition.definitionJson} />
            <div className="text-xs text-muted-foreground">{definition.triggerCount} triggers</div>
          </CardContent>
        </Card>
      ))}
      {definitions.length === 0 && <EmptyState text="No workflow definitions are available." />}
    </div>
  );
}

function TriggerList({ triggers }: { triggers: WorkflowTrigger[] }) {
  return (
    <div className="grid gap-3">
      {triggers.map((trigger) => (
        <Card key={trigger.id}>
          <CardContent className="flex min-h-20 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="font-semibold">{trigger.displayName}</div>
              <div className="text-sm text-muted-foreground">
                {trigger.triggerType} {"->"} {trigger.workflowCode}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={trigger.enabled ? "secondary" : "outline"}>{trigger.enabled ? "enabled" : "disabled"}</Badge>
              <Badge variant="outline">{trigger.lastSuccessAt ? `last success ${trigger.lastSuccessAt}` : "no success yet"}</Badge>
            </div>
          </CardContent>
        </Card>
      ))}
      {triggers.length === 0 && <EmptyState text="No workflow triggers are configured." />}
    </div>
  );
}

function RunList({ runs }: { runs: WorkflowRun[] }) {
  return (
    <div className="grid gap-3">
      {runs.map((run) => (
        <Card key={run.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="font-semibold">{run.displayName}</div>
                <div className="text-sm text-muted-foreground">
                  {run.triggerType} {run.triggerReason ? `- ${run.triggerReason}` : ""} at {run.createdAt}
                </div>
              </div>
              <Badge variant={run.status === "succeeded" ? "secondary" : run.status === "failed" ? "warning" : "outline"}>{run.status}</Badge>
            </div>
            <RunMetrics run={run} />
          </CardContent>
        </Card>
      ))}
      {runs.length === 0 && <EmptyState text="No workflow runs yet." />}
    </div>
  );
}

function WorkflowNodeBadges({ definitionJson }: { definitionJson: string }) {
  const nodes = useMemo(() => {
    try {
      const parsed = JSON.parse(definitionJson) as { nodes?: Array<{ id?: string; type?: string }> };
      return parsed.nodes ?? [];
    } catch {
      return [];
    }
  }, [definitionJson]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {nodes.map((node, index) => (
        <Badge key={`${node.id ?? "node"}-${index}`} variant="secondary">
          {node.type ?? node.id ?? "node"}
        </Badge>
      ))}
    </div>
  );
}

function RunMetrics({ run }: { run: WorkflowRun }) {
  const items = [
    { icon: <ListChecks className="h-3.5 w-3.5" />, label: "nodes", value: `${run.completedNodeRuns}/${run.nodeRunCount}` },
    { icon: <Database className="h-3.5 w-3.5" />, label: "jobs", value: `${run.completedJobs}/${run.jobCount}` },
    { icon: <Activity className="h-3.5 w-3.5" />, label: "candidates", value: `${run.acceptedCandidates}/${run.candidateCount}` },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">{item.icon}</span>
          <span className="font-medium">{item.value}</span>
          <span className="text-muted-foreground">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="p-5 text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

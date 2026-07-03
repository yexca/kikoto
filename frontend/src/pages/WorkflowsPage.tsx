import { Play, RotateCcw, Workflow } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api, type WorkflowRun } from "@/lib/api";

const runs = [
  { name: "Scan local library", status: "ready", detail: "Detect folders, extract codes, create local locations" },
  { name: "Sync DLsite metadata", status: "stub", detail: "Provider interface exists in the product boundary" },
  { name: "Refresh remote file tree", status: "planned", detail: "Kikoeru-compatible sources stay configurable" },
];

export function WorkflowsPage({ canRun, canSyncMetadata }: { canRun: boolean; canSyncMetadata: boolean }) {
  const [apiRuns, setAPIRuns] = useState<WorkflowRun[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSyncingDLsite, setIsSyncingDLsite] = useState(false);

  const refreshRuns = () => {
    api.listWorkflowRuns().then(setAPIRuns).catch(() => setAPIRuns([]));
  };

  useEffect(() => {
    refreshRuns();
  }, []);

  const runLocalScan = async () => {
    setIsRunning(true);
    try {
      await api.runLocalScan();
      refreshRuns();
    } finally {
      setIsRunning(false);
    }
  };

  const runDLsiteSync = async () => {
    setIsSyncingDLsite(true);
    try {
      await api.runDLsiteSync();
      refreshRuns();
    } finally {
      setIsSyncingDLsite(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Workflow templates</h2>
          <p className="text-sm text-muted-foreground">Long-running work stays visible as runs and jobs.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={runLocalScan} disabled={isRunning || !canRun}>
            <Play className="h-4 w-4" />
            {isRunning ? "Running" : "Run local scan"}
          </Button>
          <Button size="sm" variant="outline" onClick={runDLsiteSync} disabled={isSyncingDLsite || !canSyncMetadata}>
            <Play className="h-4 w-4" />
            {isSyncingDLsite ? "Syncing" : "Sync DLsite"}
          </Button>
        </div>
      </div>

      {apiRuns.length > 0 && (
        <div className="grid gap-3">
          {apiRuns.map((run) => (
            <Card key={run.id}>
              <CardContent className="flex min-h-20 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="font-semibold">{run.templateCode}</div>
                  <div className="text-sm text-muted-foreground">
                    {run.triggerReason} at {run.createdAt}
                  </div>
                </div>
                <Badge variant={run.status === "succeeded" ? "secondary" : "outline"}>{run.status}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid gap-3">
        {runs.map((run) => (
          <Card key={run.name}>
            <CardContent className="flex min-h-24 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground">
                  <Workflow className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold">{run.name}</div>
                  <div className="text-sm text-muted-foreground">{run.detail}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={run.status === "planned" ? "outline" : "secondary"}>{run.status}</Badge>
                <Button variant="outline" size="icon" aria-label="Retry">
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

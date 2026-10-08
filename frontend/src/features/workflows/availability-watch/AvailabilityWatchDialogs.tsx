import { Activity, ExternalLink, GitBranchPlus, Loader2, Save, Trash2 } from "lucide-react";
import { useState } from "react";

import { openWorkDetail } from "@/app/workDetailNavigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { parseWorkCodes, WorkCodesField } from "@/features/workflows/WorkCodesField";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { ErrorPanel, Field, Modal } from "@/features/workflows/WorkflowPanelParts";
import { api, type AvailabilityWatch } from "@/lib/api";

export function AvailabilityWatchMonitoringDialog({
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
  const [codes, setCodes] = useState(() => watch.targets.map((target) => target.workCode));
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

export function AvailabilityWatchReadyDialog({
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

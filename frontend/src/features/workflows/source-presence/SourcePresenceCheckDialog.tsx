import { ListChecks } from "lucide-react";
import { useEffect, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { RunBusyLabelContext, RunOptionRows, WorkflowRunButton } from "@/features/workflows/RunOptionControls";
import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { intervalLabel } from "@/features/workflows/workflowTriggerModel";
import { api, type FileSourcePresenceCheck, type SourcePresenceCheckOptions } from "@/lib/api";
import { openWorkflowRun } from "@/lib/workflowLinks";

import { SourcePresenceCheckLine } from "./SourcePresenceCheckLine";
import { sourceCheckIntervalChoices, sourceCheckPausedMessage, sourceCheckSettings } from "./sourcePresenceCheckModel";
import { SourcePresenceScopeFields } from "./SourcePresenceScopeFields";

/**
 * One remote source's library work check: its latest run, the options that
 * Run and the automatic checks share, and whether it also runs at startup and
 * on an interval. Run queues a check and closes; automatic checks save as
 * soon as they change, all of the source's settings together.
 */
export function SourcePresenceCheckDialog({
  source,
  check,
  readOnly = false,
  canOpenActivity,
  onChanged,
  onClose,
}: {
  source: { id: number; displayName: string; enabled: boolean };
  check: FileSourcePresenceCheck;
  /** Demo shows the options and automatic checks for inspection; nothing runs or saves. */
  readOnly?: boolean;
  canOpenActivity: boolean;
  /** A check was queued or an automatic check changed. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  // A save answers with the stored checks; the source list shows them once it reloads.
  const [saved, setSaved] = useState<FileSourcePresenceCheck | null>(null);
  const [options, setOptionsState] = useState<SourcePresenceCheckOptions>(check.options);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setSaved(null), [check]);

  const current = saved ?? check;
  const interval = current.schedule.intervalMinutes;
  const startupOn = current.startup.enabled;
  const scheduleOn = current.schedule.enabled;
  const running = Boolean(check.lastRun && isActiveRunStatus(check.lastRun.status));
  const editable = !readOnly && !saving;
  const pausedMessage = sourceCheckPausedMessage(current);

  /** Saves the source's options and automatic checks as one change. */
  const save = async (
    nextOptions: SourcePresenceCheckOptions,
    change: { startup?: boolean; schedule?: boolean; intervalMinutes?: number } = {},
  ) => {
    setSaving(true);
    setError("");
    try {
      setSaved(await api.updateSourcePresenceCheck(source.id, sourceCheckSettings(current, nextOptions, change)));
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("sourceCheck.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  // The automatic checks run with the same options, so a change saves to them as well.
  const setOptions = (update: SetStateAction<SourcePresenceCheckOptions>) => {
    const next = typeof update === "function" ? update(options) : update;
    setOptionsState(next);
    if (readOnly || (!startupOn && !scheduleOn)) return;
    void save(next);
  };

  const run = async () => {
    if (readOnly || submitting) return;
    setSubmitting(true);
    try {
      const result = await api.runSourcePresenceCheck(options);
      toast.notify({
        kind: "success",
        message: workflowCopy("sourceCheck.queued", { id: result.runId }),
        actionLabel: canOpenActivity ? t("workflowPage.viewRun") : undefined,
        onAction: canOpenActivity ? () => openWorkflowRun(result.runId) : undefined,
      });
      onChanged();
      onClose();
    } catch (err) {
      toast.notify(toastFromError(err, workflowCopy("sourceCheck.queueFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  const nextScheduled = scheduleOn ? current.nextRunAt : null;

  return (
    <Dialog onClose={onClose} size="lg">
      <DialogHeader
        icon={<ListChecks className="h-5 w-5" />}
        title={workflowCopy("sourceCheck.title")}
        description={workflowCopy("sourceCheck.description", { name: source.displayName })}
        onClose={onClose}
      />
      <DialogBody className="workflow-options grid min-w-0 gap-6">
        <p className="text-sm">
          <SourcePresenceCheckLine
            check={check}
            onOpenRun={
              canOpenActivity
                ? (runId) => {
                    onClose();
                    openWorkflowRun(runId);
                  }
                : undefined
            }
          />
        </p>
        <section className="grid gap-3" aria-label={workflowCopy("sourceCheck.options")}>
          <div>
            <h3 className="text-sm font-semibold">{workflowCopy("sourceCheck.options")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{workflowCopy("sourceCheck.optionsHint")}</p>
          </div>
          <RunOptionRows>
            <SourcePresenceScopeFields value={options} onChange={setOptions} disabled={readOnly || saving} />
          </RunOptionRows>
        </section>
        <section className="grid gap-3" aria-label={workflowCopy("sourceCheck.automatic")}>
          <h3 className="text-sm font-semibold">{workflowCopy("sourceCheck.automatic")}</h3>
          <div className="grid gap-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">{workflowCopy("sourceCheck.atStartup")}</div>
                <div className="text-xs text-muted-foreground">{workflowCopy("sourceCheck.atStartupHint")}</div>
              </div>
              <Switch
                checked={startupOn}
                disabled={!editable || (!startupOn && !source.enabled)}
                onCheckedChange={(enabled) => void save(options, { startup: enabled })}
                aria-label={workflowCopy("sourceCheck.atStartup")}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{workflowCopy("sourceCheck.onSchedule")}</div>
                {nextScheduled && (
                  <div className="text-xs text-muted-foreground">
                    {workflowCopy("next")} <RelativeTime value={nextScheduled} fallback="" />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {scheduleOn && (
                  <NativeSelect
                    fieldSize="sm"
                    aria-label={workflowCopy("sourceCheck.interval")}
                    value={String(interval)}
                    disabled={!editable}
                    onChange={(event) => void save(options, { intervalMinutes: Number(event.target.value) })}
                  >
                    {sourceCheckIntervalChoices(interval).map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {intervalLabel(minutes)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                <Switch
                  checked={scheduleOn}
                  disabled={!editable || (!scheduleOn && !source.enabled)}
                  onCheckedChange={(enabled) => void save(options, { schedule: enabled })}
                  aria-label={workflowCopy("sourceCheck.onSchedule")}
                />
              </div>
            </div>
            {pausedMessage && <p className="text-xs text-warning-foreground">{pausedMessage}</p>}
          </div>
          {error && (
            <p className="text-xs text-error-foreground" role="alert">
              {error}
            </p>
          )}
        </section>
      </DialogBody>
      <DialogFooter className="items-center">
        <p className="mr-auto min-w-0 flex-1 text-xs text-muted-foreground">
          {!source.enabled ? workflowCopy("sourceCheck.sourceDisabled") : null}
        </p>
        <Button variant="outline" size="sm" onClick={onClose}>
          {workflowCopy("cancel")}
        </Button>
        <RunBusyLabelContext.Provider value={running && !submitting ? t("workflowActivity.status.running") : null}>
          <WorkflowRunButton
            running={running || submitting}
            disabled={readOnly || !source.enabled}
            onClick={() => void run()}
          />
        </RunBusyLabelContext.Provider>
      </DialogFooter>
    </Dialog>
  );
}

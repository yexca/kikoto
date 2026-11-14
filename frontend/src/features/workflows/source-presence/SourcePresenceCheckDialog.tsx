import { ListChecks } from "lucide-react";
import { useCallback, useEffect, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { RunBusyLabelContext, RunOptionRows, WorkflowRunButton } from "@/features/workflows/RunOptionControls";
import { isActiveRunStatus } from "@/features/workflows/runPresentation";
import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { openWorkflowPath, workflowActivityRunPath } from "@/features/workflows/workflowLinks";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { intervalParts } from "@/features/workflows/workflowTriggerModel";
import { api, type FileSourcePresenceCheck, type SourcePresenceCheckOptions, type WorkflowTrigger } from "@/lib/api";

import { SourcePresenceCheckLine } from "./SourcePresenceCheckLine";
import {
  SOURCE_PRESENCE_CHECK_CODE,
  sourceCheckConfigJson,
  sourceCheckDefaults,
  sourceCheckInterval,
  sourceCheckIntervalChoices,
  sourceCheckOptions,
  sourceCheckTriggers,
  type SourceCheckTriggers,
} from "./sourcePresenceCheckModel";
import { SourcePresenceScopeFields } from "./SourcePresenceScopeFields";

const intervalKey = {
  minutes: "workflowPage.operations.schedule.everyMinutes",
  hours: "workflowPage.operations.schedule.everyHours",
  days: "workflowPage.operations.schedule.everyDays",
} as const;

type AutomaticKind = "startup" | "schedule";

/**
 * One remote source's library work check: its latest run, the options that
 * Run and the automatic checks share, and whether it also runs at startup and
 * on an interval. Run queues a check and closes; automatic checks save as
 * soon as they change.
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
  check: FileSourcePresenceCheck | undefined;
  /** Demo shows the options and automatic checks for inspection; nothing runs or saves. */
  readOnly?: boolean;
  canOpenActivity: boolean;
  /** A check was queued or an automatic check changed. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [triggers, setTriggers] = useState<SourceCheckTriggers>({ startup: [], schedule: [] });
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [options, setOptionsState] = useState<SourcePresenceCheckOptions>(() => sourceCheckDefaults(source.id));
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [definitions, allTriggers] = await Promise.all([api.listWorkflowDefinitions(), api.listWorkflowTriggers()]);
    const definition = definitions.find((item) => item.code === SOURCE_PRESENCE_CHECK_CODE) ?? null;
    const own = sourceCheckTriggers(allTriggers, source.id);
    setDefinitionId(definition?.id ?? null);
    setTriggers(own);
    return own;
  }, [source.id]);

  useEffect(() => {
    let active = true;
    load()
      .then((own) => {
        if (!active) return;
        setOptionsState(sourceCheckOptions(own, source.id));
        setLoadState("ready");
      })
      .catch(() => {
        if (active) setLoadState("failed");
      });
    return () => {
      active = false;
    };
  }, [load, source.id]);

  const interval = sourceCheckInterval(triggers.schedule);
  const startupOn = triggers.startup.some((trigger) => trigger.enabled);
  const scheduleOn = triggers.schedule.some((trigger) => trigger.enabled);
  const running = Boolean(check?.lastRun && isActiveRunStatus(check.lastRun.status));
  const editable = !readOnly && loadState === "ready" && definitionId !== null && !saving;
  const pausedMessage = [...triggers.startup, ...triggers.schedule].find(
    (trigger) => !trigger.enabled && trigger.lastErrorMessage,
  )?.lastErrorMessage;

  /** Saves the automatic checks of one kind, or creates the first, then reloads them. */
  const saveKind = async (
    kind: AutomaticKind,
    change: { enabled?: boolean; intervalMinutes?: number; options?: SourcePresenceCheckOptions },
  ) => {
    if (definitionId === null) return;
    setSaving(true);
    setError("");
    try {
      const existing = triggers[kind];
      const next = change.options ?? options;
      const scheduleJson = (trigger?: WorkflowTrigger) =>
        kind === "schedule"
          ? JSON.stringify({ intervalMinutes: change.intervalMinutes ?? interval })
          : (trigger?.scheduleJson ?? JSON.stringify({ type: "startup" }));
      const payload = (trigger?: WorkflowTrigger) => ({
        workflowDefinitionId: definitionId,
        displayName: t(`workflowPage.builtInDefinitions.${SOURCE_PRESENCE_CHECK_CODE}.name`),
        triggerType: kind,
        enabled: change.enabled ?? trigger?.enabled ?? true,
        scheduleJson: scheduleJson(trigger),
        configJson: sourceCheckConfigJson(next),
        nextRunAt: null,
      });
      if (existing.length === 0) await api.createWorkflowTrigger(payload());
      else for (const trigger of existing) await api.updateWorkflowTrigger(trigger.id, payload(trigger));
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("sourceCheck.saveFailed"));
      await load().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  // The automatic checks run with the same options, so a change saves to them as well.
  const setOptions = (update: SetStateAction<SourcePresenceCheckOptions>) => {
    const next = typeof update === "function" ? update(options) : update;
    setOptionsState(next);
    if (readOnly) return;
    void (async () => {
      if (triggers.startup.length > 0) await saveKind("startup", { options: next });
      if (triggers.schedule.length > 0) await saveKind("schedule", { options: next });
    })();
  };

  const run = async () => {
    if (readOnly || submitting) return;
    setSubmitting(true);
    try {
      const result = await api.runSourcePresenceCheck(options);
      toast.notify({
        kind: "success",
        message: workflowCopy("sourceCheck.queued", { id: result.runId }),
        actionLabel: canOpenActivity ? t("nav.activity") : undefined,
        onAction: canOpenActivity ? () => openWorkflowPath(workflowActivityRunPath(result.runId)) : undefined,
      });
      onChanged();
      onClose();
    } catch (err) {
      toast.notify(toastFromError(err, workflowCopy("sourceCheck.queueFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  const nextScheduled = triggers.schedule.find((trigger) => trigger.enabled && trigger.nextRunAt)?.nextRunAt ?? null;
  const intervalLabel = (minutes: number) => {
    const parts = intervalParts(minutes);
    return t(intervalKey[parts.unit], { count: parts.count });
  };

  return (
    <Dialog onClose={onClose} size="lg">
      <DialogHeader
        icon={<ListChecks className="h-5 w-5" />}
        title={workflowCopy("sourceCheck.title")}
        description={workflowCopy("sourceCheck.description", { name: source.displayName })}
        onClose={onClose}
      />
      <DialogBody className="workflow-options grid min-w-0 gap-6">
        {check && (
          <p className="text-sm">
            <SourcePresenceCheckLine
              check={check}
              onOpenRun={
                canOpenActivity
                  ? (runId) => {
                      onClose();
                      openWorkflowPath(workflowActivityRunPath(runId));
                    }
                  : undefined
              }
            />
          </p>
        )}
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
          {loadState === "failed" ? (
            <p className="text-sm text-error-foreground" role="alert">
              {workflowCopy("sourceCheck.loadFailed")}
            </p>
          ) : (
            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{workflowCopy("sourceCheck.atStartup")}</div>
                  <div className="text-xs text-muted-foreground">{workflowCopy("sourceCheck.atStartupHint")}</div>
                </div>
                <Switch
                  checked={startupOn}
                  disabled={!editable || (!startupOn && !source.enabled)}
                  onCheckedChange={(enabled) => void saveKind("startup", { enabled })}
                  aria-label={workflowCopy("sourceCheck.atStartup")}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{workflowCopy("sourceCheck.onSchedule")}</div>
                  {scheduleOn && nextScheduled && (
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
                      onChange={(event) => void saveKind("schedule", { intervalMinutes: Number(event.target.value) })}
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
                    onCheckedChange={(enabled) => void saveKind("schedule", { enabled })}
                    aria-label={workflowCopy("sourceCheck.onSchedule")}
                  />
                </div>
              </div>
              {pausedMessage && <p className="text-xs text-warning-foreground">{pausedMessage}</p>}
            </div>
          )}
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

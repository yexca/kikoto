import { CalendarClock, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { MetadataRunOptions } from "@/features/workflows/operations/metadataRunOptions";
import { SegmentedControl } from "@/features/workflows/RunOptionControls";
import { RelativeTime } from "@/features/workflows/WorkflowDetailLayout";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import {
  afterTriggerLabel,
  defaultTriggerInterval,
  intervalLabel,
  operationTriggerKinds,
  operationTriggerSlots,
  switchedOperationTriggerConfig,
  triggerInterval,
  triggerIntervalChoices,
  triggerOffersFull,
  triggerRunsFull,
  triggerScheduleJson,
  workflowTriggerCondition,
  type OperationTriggerKind,
} from "@/features/workflows/workflowTriggerModel";
import { useArmedConfirm } from "@/hooks/useArmedConfirm";
import { api, type WorkflowDefinition, type WorkflowTrigger } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { TriggerListItem } from "./TriggerListItem";

/** An operation whose triggers the dialog shows, with the name its card uses. */
export type TriggerDialogOperation = { definition: WorkflowDefinition; name: string };

type TriggerChange = { enabled?: boolean; intervalMinutes?: number; full?: boolean };

/**
 * One operation's triggers as one switch per kind it takes: at startup or
 * after the scan it follows, watching folders for Scan, and on a schedule.
 * A switch turned on the first time creates its trigger; after that it pauses
 * and resumes it, keeping its interval and mode. While on, a schedule shows its
 * interval, and a trigger that can run in full chooses Incremental or Full.
 * Every change saves at once. A Metadata trigger runs with the Metadata card's
 * options. Another trigger of a kind already switched, such as a second
 * schedule created through the API, is listed below to pause or delete.
 */
export function OperationTriggersDialog({
  operation,
  triggers,
  canManage,
  readOnly,
  metadataConfigJson,
  metadataOptions,
  onChanged,
  onClose,
}: {
  operation: TriggerDialogOperation;
  /** The operation's triggers, kept current while the dialog is open. */
  triggers: WorkflowTrigger[];
  canManage: boolean;
  /** Demo shows the triggers for inspection; nothing saves. */
  readOnly: boolean;
  /** What a new Metadata trigger stores: the Metadata card's run options. */
  metadataConfigJson?: string;
  /** The Metadata card's options, which every Metadata trigger saved here runs with. */
  metadataOptions?: MetadataRunOptions;
  /** A trigger was added, changed, or deleted. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const code = operation.definition.code;
  const editable = canManage && !readOnly;
  const [items, setItems] = useState(triggers);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const confirm = useArmedConfirm<number>();

  useEffect(() => setItems(triggers), [triggers]);

  const { slots, others } = operationTriggerSlots(code, items);
  const kindLabel = (kind: OperationTriggerKind) =>
    kind === "startup"
      ? t("workflowPage.operations.schedule.startup")
      : kind === "after_workflow"
        ? afterTriggerLabel(code)
        : kind === "filesystem_event"
          ? workflowCopy("whenFoldersChange")
          : t("workflowPage.triggers.onSchedule");

  const keep = (saved: WorkflowTrigger) =>
    setItems((current) =>
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [...current, saved],
    );

  const save = async (kind: OperationTriggerKind, change: TriggerChange) => {
    if (!editable) return;
    const current = slots.get(kind) ?? null;
    const enabled = change.enabled ?? current?.enabled ?? false;
    const intervalMinutes = change.intervalMinutes ?? (current ? triggerInterval(current) : defaultTriggerInterval);
    const full = triggerOffersFull(code, kind) && (change.full ?? (current ? triggerRunsFull(code, current) : false));
    const payload = {
      workflowDefinitionId: operation.definition.id,
      displayName: current?.displayName ?? `${operation.name} · ${kindLabel(kind)}`,
      triggerType: kind,
      enabled,
      scheduleJson:
        kind === "schedule" || !current ? triggerScheduleJson(code, kind, intervalMinutes) : current.scheduleJson,
      configJson: JSON.stringify(
        switchedOperationTriggerConfig(code, kind, full, current, metadataConfigJson, metadataOptions),
      ),
      nextRunAt: null,
    };
    setBusy(kind);
    setError("");
    try {
      keep(current ? await api.updateWorkflowTrigger(current.id, payload) : await api.createWorkflowTrigger(payload));
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const toggleOther = async (trigger: WorkflowTrigger, enabled: boolean) => {
    setBusy(String(trigger.id));
    setError("");
    try {
      keep(
        await api.updateWorkflowTrigger(trigger.id, {
          workflowDefinitionId: trigger.workflowDefinitionId,
          displayName: trigger.displayName,
          triggerType: trigger.triggerType,
          enabled,
          scheduleJson: trigger.scheduleJson,
          configJson: trigger.configJson,
          nextRunAt: null,
        }),
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("saveFailed"));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (trigger: WorkflowTrigger) => {
    confirm.disarm();
    setBusy(String(trigger.id));
    setError("");
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      setItems((current) => current.filter((item) => item.id !== trigger.id));
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("deleteFailed"));
    } finally {
      setBusy(null);
    }
  };

  const disabled = !editable || busy !== null;
  const kinds = operationTriggerKinds(code).filter(
    // The folder watcher is fixed: it is switched only when the scan has one.
    (kind) => kind !== "filesystem_event" || slots.has(kind),
  );

  return (
    <Dialog onClose={onClose} size="md">
      <DialogHeader
        icon={<CalendarClock className="h-5 w-5" />}
        title={t("workflowPage.triggers.title", { name: operation.name })}
        onClose={onClose}
      />
      <DialogBody className="grid gap-3">
        <ul className="divide-y rounded-lg border">
          {kinds.map((kind) => {
            const trigger = slots.get(kind) ?? null;
            const on = Boolean(trigger?.enabled);
            const label = kindLabel(kind);
            const interval = trigger ? triggerInterval(trigger) : defaultTriggerInterval;
            const full = trigger ? triggerRunsFull(code, trigger) : false;
            return (
              <TriggerSwitchRow
                key={kind}
                label={label}
                on={on}
                disabled={disabled}
                saving={busy === kind}
                detail={
                  on && kind === "schedule" && trigger?.nextRunAt ? (
                    <>
                      {workflowCopy("next")} <RelativeTime value={trigger.nextRunAt} fallback="" />
                    </>
                  ) : null
                }
                error={trigger?.lastErrorMessage ?? ""}
                onChange={(enabled) => void save(kind, { enabled })}
                controls={on && (kind === "schedule" || triggerOffersFull(code, kind))}
              >
                {kind === "schedule" && (
                  <NativeSelect
                    fieldSize="sm"
                    aria-label={t("workflowPage.triggers.interval")}
                    value={String(interval)}
                    disabled={disabled}
                    onChange={(event) => void save(kind, { intervalMinutes: Number(event.target.value) })}
                  >
                    {triggerIntervalChoices(interval).map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {intervalLabel(minutes)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
                {triggerOffersFull(code, kind) && (
                  <SegmentedControl
                    label={t("workflowPage.triggers.mode", { name: label })}
                    value={full ? "full" : "incremental"}
                    disabled={disabled}
                    options={[
                      { value: "incremental", label: workflowCopy("incremental") },
                      { value: "full", label: workflowCopy("full") },
                    ]}
                    onChange={(value) => void save(kind, { full: value === "full" })}
                  />
                )}
              </TriggerSwitchRow>
            );
          })}
        </ul>
        {others.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {others.map((trigger) => {
              const label = workflowTriggerCondition(trigger) ?? trigger.displayName;
              const armed = confirm.armed === trigger.id;
              return (
                <TriggerListItem
                  key={trigger.id}
                  trigger={trigger}
                  label={label}
                  showCondition={false}
                  toggle={{ disabled, onChange: (enabled) => void toggleOther(trigger, enabled) }}
                  action={
                    readOnly ? null : (
                      <Button
                        size={armed ? "sm" : "icon"}
                        variant={armed ? "destructive" : "ghost"}
                        className={cn("shrink-0", !armed && "text-muted-foreground")}
                        title={armed ? undefined : t("workflowPage.triggers.deleteNamed", { name: label })}
                        aria-label={
                          armed
                            ? `${t("workflowPage.triggers.confirmDelete")} ${label}`
                            : t("workflowPage.triggers.deleteNamed", { name: label })
                        }
                        disabled={disabled}
                        onClick={() => (armed ? void remove(trigger) : confirm.arm(trigger.id))}
                      >
                        {busy === String(trigger.id) ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : armed ? (
                          t("workflowPage.triggers.confirmDelete")
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    )
                  }
                />
              );
            })}
          </ul>
        )}
        {error && (
          <p className="text-sm text-error-foreground" role="alert">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {workflowCopy("close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** One kind of trigger: when it runs, what it shows while on, and its switch. */
function TriggerSwitchRow({
  label,
  on,
  disabled,
  saving,
  detail,
  error,
  onChange,
  controls,
  children,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  saving: boolean;
  detail: ReactNode;
  error: string;
  onChange: (enabled: boolean) => void;
  /** Whether the interval or mode controls show, which they do only while the trigger is on. */
  controls: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="grid min-w-0 gap-2 px-3 py-2.5">
      <div className="flex min-h-[var(--control-height-sm)] min-w-0 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className={cn("text-sm font-medium", !on && "text-muted-foreground")}>{label}</div>
          {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
        </div>
        {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        <Switch checked={on} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
      </div>
      {controls && <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>}
      {on && error && (
        <div className="break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
          {workflowCopy("lastError")}: {error}
        </div>
      )}
    </li>
  );
}

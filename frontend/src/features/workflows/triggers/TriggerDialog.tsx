import { CalendarClock, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/input";
import { OptionField, RunOptionRows, SegmentedControl, SwitchControl } from "@/features/workflows/RunOptionControls";
import { workflowCopy } from "@/features/workflows/workflowPageModel";
import {
  defaultTriggerInterval,
  intervalLabel,
  operationTriggerConfig,
  operationTriggerKinds,
  triggerInterval,
  triggerIntervalChoices,
  triggerOffersFull,
  triggerRunsFull,
  type OperationTriggerKind,
} from "@/features/workflows/workflowTriggerModel";
import { api, type WorkflowDefinition, type WorkflowTrigger } from "@/lib/api";

/** An operation the dialog can add a trigger for, with the name its card uses. */
export type TriggerDialogOperation = { definition: WorkflowDefinition; name: string };

/**
 * Adds a trigger to one of the operations, or edits one: which operation,
 * whether it runs at startup or on an interval, and whether it runs in full.
 * An operation runs at startup once at most, and watching folders is the
 * scan's one fixed trigger, which keeps its kind and only changes Full.
 */
export function TriggerDialog({
  operations,
  triggers,
  trigger,
  readOnly,
  metadataConfigJson,
  onClose,
  onSaved,
}: {
  operations: TriggerDialogOperation[];
  /** Every trigger of the operations, to tell which already run at startup. */
  triggers: WorkflowTrigger[];
  /** The trigger to edit; null to add one. */
  trigger: WorkflowTrigger | null;
  /** Demo shows the trigger for inspection; nothing saves. */
  readOnly: boolean;
  /** What a new Metadata trigger starts from: the Metadata card's options. */
  metadataConfigJson?: string;
  onClose: () => void;
  /** A trigger was added, changed, or deleted. */
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const editedOperation = trigger
    ? (operations.find((operation) => operation.definition.id === trigger.workflowDefinitionId) ?? null)
    : null;
  const [code, setCode] = useState(
    editedOperation?.definition.code ?? operations[0]?.definition.code ?? "local_library_scan",
  );
  const operation = operations.find((item) => item.definition.code === code) ?? null;
  const hasStartup = (definitionId: number) =>
    triggers.some(
      (item) => item.workflowDefinitionId === definitionId && item.triggerType === "startup" && item.id !== trigger?.id,
    );
  const kindsFor = (operationCode: string) => {
    const definition = operations.find((item) => item.definition.code === operationCode)?.definition;
    return operationTriggerKinds(operationCode).filter(
      (kind) => kind !== "startup" || !definition || !hasStartup(definition.id),
    );
  };
  const [kind, setKind] = useState<string>(() => trigger?.triggerType ?? kindsFor(code)[0] ?? "schedule");
  const [interval, setIntervalMinutes] = useState(() => (trigger ? triggerInterval(trigger) : defaultTriggerInterval));
  const [full, setFull] = useState(() => (trigger ? triggerRunsFull(code, trigger) : false));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const kinds = kindsFor(code);
  const offersFull = triggerOffersFull(code, kind);
  const watching = kind === "filesystem_event";
  const kindLabel = (value: string) =>
    value === "startup"
      ? t("workflowPage.operations.schedule.startup")
      : value === "filesystem_event"
        ? workflowCopy("whenFoldersChange")
        : t("workflowPage.triggers.onSchedule");

  const chooseOperation = (next: string) => {
    setCode(next);
    const nextKinds = kindsFor(next);
    if (!nextKinds.includes(kind as OperationTriggerKind)) setKind(nextKinds[0] ?? "schedule");
    setFull(false);
  };

  const save = async () => {
    if (!operation || readOnly) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        workflowDefinitionId: operation.definition.id,
        // The folder trigger is fixed: its name and schedule stay as they are.
        displayName: trigger?.displayName ?? `${operation.name} · ${kindLabel(kind)}`,
        triggerType: kind,
        enabled: trigger?.enabled ?? true,
        scheduleJson:
          kind === "schedule"
            ? JSON.stringify({ intervalMinutes: interval })
            : (trigger?.scheduleJson ?? JSON.stringify({ type: "startup" })),
        configJson: JSON.stringify(
          operationTriggerConfig(
            code,
            kind,
            offersFull && full,
            trigger?.configJson ?? (code === "metadata_sync" ? metadataConfigJson : undefined),
          ),
        ),
        nextRunAt: null,
      };
      if (trigger) await api.updateWorkflowTrigger(trigger.id, payload);
      else await api.createWorkflowTrigger(payload);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trigger || readOnly) return;
    setSaving(true);
    setError("");
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("deleteFailed"));
    } finally {
      setSaving(false);
    }
  };

  const fullHint =
    code === "metadata_sync"
      ? t("workflowPage.cards.fullHint.metadata_sync")
      : code === "local_media_index"
        ? t("workflowPage.cards.fullHint.local_media_index")
        : t("workflowPage.cards.fullHint.local_library_scan");

  return (
    <Dialog onClose={onClose} size="md" dismissible={!saving}>
      <DialogHeader
        icon={<CalendarClock className="h-5 w-5" />}
        title={trigger ? t("workflowPage.triggers.editTitle") : t("workflowPage.triggers.addTitle")}
        description={t("workflowPage.triggers.description")}
        onClose={onClose}
      />
      <DialogBody className="workflow-options grid min-w-0 gap-4">
        <fieldset disabled={readOnly || saving} className="m-0 min-w-0 border-0 p-0">
          <RunOptionRows>
            <OptionField label={t("workflowPage.triggers.operation")}>
              {trigger ? (
                <p className="flex min-h-[var(--control-height-sm)] items-center text-sm">{editedOperation?.name}</p>
              ) : (
                <SegmentedControl
                  label={t("workflowPage.triggers.operation")}
                  value={code}
                  options={operations.map((item) => ({
                    value: item.definition.code,
                    label: item.name,
                    disabled: kindsFor(item.definition.code).length === 0,
                  }))}
                  onChange={chooseOperation}
                />
              )}
            </OptionField>
            <OptionField
              label={t("workflowPage.triggers.when")}
              hint={
                !trigger && operationTriggerKinds(code).includes("startup") && !kinds.includes("startup")
                  ? t("workflowPage.triggers.startupTaken")
                  : undefined
              }
            >
              {trigger ? (
                <p className="flex min-h-[var(--control-height-sm)] items-center text-sm">{kindLabel(kind)}</p>
              ) : (
                <SegmentedControl
                  label={t("workflowPage.triggers.when")}
                  value={kind}
                  options={operationTriggerKinds(code).map((value) => ({
                    value,
                    label: kindLabel(value),
                    disabled: !kinds.includes(value),
                  }))}
                  onChange={setKind}
                />
              )}
            </OptionField>
            {kind === "schedule" && (
              <OptionField label={t("workflowPage.triggers.interval")} htmlFor="trigger-interval">
                <NativeSelect
                  id="trigger-interval"
                  fieldSize="sm"
                  className="w-48"
                  value={String(interval)}
                  onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                >
                  {triggerIntervalChoices(interval).map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {intervalLabel(minutes)}
                    </option>
                  ))}
                </NativeSelect>
              </OptionField>
            )}
            <OptionField label={t("workflowPage.cards.full")}>
              {offersFull ? (
                <SwitchControl
                  label={t("workflowPage.cards.full")}
                  description={full ? fullHint : t("workflowPage.triggers.incrementalHint")}
                  checked={full}
                  onCheckedChange={setFull}
                />
              ) : (
                <p className="flex min-h-[var(--control-height-sm)] items-center text-xs text-muted-foreground">
                  {t("workflowPage.cards.scanAlwaysFull")}
                </p>
              )}
            </OptionField>
          </RunOptionRows>
        </fieldset>
        {error && (
          <p className="text-sm text-error-foreground" role="alert">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter className="items-center">
        {trigger && !watching && (
          <Button
            variant="outline"
            size="sm"
            className="mr-auto"
            onClick={() => void remove()}
            disabled={readOnly || saving}
          >
            <Trash2 className="h-4 w-4" />
            {workflowCopy("delete")}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
          {workflowCopy("cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={readOnly || saving || !operation || (!trigger && !kinds.includes(kind as OperationTriggerKind))}
        >
          <Save className="h-4 w-4" />
          {saving ? workflowCopy("saving") : trigger ? workflowCopy("save") : workflowCopy("addTrigger")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

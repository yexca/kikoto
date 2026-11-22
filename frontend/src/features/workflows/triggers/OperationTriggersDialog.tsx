import { CalendarClock, CalendarPlus, Edit3, Eye, Save, Trash2 } from "lucide-react";
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
  nextTriggerOrder,
  operationTriggerConfig,
  operationTriggerKinds,
  triggerInterval,
  triggerIntervalChoices,
  triggerOffersFull,
  triggerRunsFull,
  workflowTriggerCondition,
  type OperationTriggerKind,
} from "@/features/workflows/workflowTriggerModel";
import { api, type WorkflowDefinition, type WorkflowTrigger } from "@/lib/api";

import { TriggerListItem } from "./TriggerListItem";

/** An operation whose triggers the dialog shows, with the name its card uses. */
export type TriggerDialogOperation = { definition: WorkflowDefinition; name: string };

/** The form the dialog shows, and where it goes once the form is done. */
type FormView = { trigger: WorkflowTrigger | null; back: "list" | "close" };

/**
 * One operation's triggers: each one's switch and edit button, and Add
 * trigger. An operation without triggers opens straight to adding one, and a
 * trigger opened from Next opens straight to its form; a form returns to
 * where it was opened from.
 */
export function OperationTriggersDialog({
  operation,
  triggers,
  editing = null,
  canManage,
  readOnly,
  metadataConfigJson,
  onToggle,
  onChanged,
  onClose,
}: {
  operation: TriggerDialogOperation;
  /** The operation's triggers, kept current while the dialog is open. */
  triggers: WorkflowTrigger[];
  /** A trigger to open straight to its form. */
  editing?: WorkflowTrigger | null;
  canManage: boolean;
  /** Demo shows the triggers for inspection; nothing saves. */
  readOnly: boolean;
  /** What a new Metadata trigger starts from: the Metadata card's options. */
  metadataConfigJson?: string;
  onToggle: (trigger: WorkflowTrigger, enabled: boolean) => void;
  /** A trigger was added, changed, or deleted. */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormView | null>(() =>
    editing ? { trigger: editing, back: "close" } : triggers.length === 0 ? { trigger: null, back: "close" } : null,
  );
  const [saving, setSaving] = useState(false);
  const editable = canManage && !readOnly;

  const leaveForm = () => (form?.back === "list" ? setForm(null) : onClose());

  return (
    <Dialog onClose={onClose} size="md" dismissible={!saving}>
      {form ? (
        <TriggerForm
          key={form.trigger?.id ?? "add"}
          operation={operation}
          triggers={triggers}
          trigger={form.trigger}
          readOnly={!editable}
          metadataConfigJson={metadataConfigJson}
          saving={saving}
          setSaving={setSaving}
          onCancel={leaveForm}
          onClose={onClose}
          onSaved={() => {
            onChanged();
            leaveForm();
          }}
        />
      ) : (
        <>
          <DialogHeader
            icon={<CalendarClock className="h-5 w-5" />}
            title={t("workflowPage.triggers.title", { name: operation.name })}
            onClose={onClose}
          />
          <DialogBody>
            {triggers.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{t("workflowPage.triggers.none")}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {nextTriggerOrder(triggers).map((trigger) => {
                  const label = workflowTriggerCondition(trigger) ?? trigger.displayName;
                  const action = readOnly
                    ? workflowCopy("viewTrigger", { name: label })
                    : t("workflowPage.triggers.edit");
                  return (
                    <TriggerListItem
                      key={trigger.id}
                      trigger={trigger}
                      label={label}
                      showCondition={false}
                      toggle={{ disabled: !editable, onChange: (enabled) => onToggle(trigger, enabled) }}
                      action={
                        <Button
                          size="icon"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground"
                          title={action}
                          aria-label={readOnly ? action : `${action} ${label}`}
                          onClick={() => setForm({ trigger, back: "list" })}
                        >
                          {readOnly ? <Eye className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
                        </Button>
                      }
                    />
                  );
                })}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose}>
              {workflowCopy("close")}
            </Button>
            <Button size="sm" disabled={!editable} onClick={() => setForm({ trigger: null, back: "list" })}>
              <CalendarPlus className="h-4 w-4" />
              {t("workflowPage.triggers.add")}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

/**
 * Adds a trigger to the operation, or edits one: whether it runs at startup
 * or on an interval, and whether it runs in full. An operation runs at
 * startup once at most, and watching folders is the scan's one fixed
 * trigger, which keeps its kind and only changes Full.
 */
function TriggerForm({
  operation,
  triggers,
  trigger,
  readOnly,
  metadataConfigJson,
  saving,
  setSaving,
  onCancel,
  onClose,
  onSaved,
}: {
  operation: TriggerDialogOperation;
  triggers: WorkflowTrigger[];
  trigger: WorkflowTrigger | null;
  readOnly: boolean;
  metadataConfigJson?: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const code = operation.definition.code;
  const startupTaken = triggers.some((item) => item.triggerType === "startup" && item.id !== trigger?.id);
  const kinds = operationTriggerKinds(code).filter((kind) => kind !== "startup" || !startupTaken);
  const [kind, setKind] = useState<string>(() => trigger?.triggerType ?? kinds[0] ?? "schedule");
  const [interval, setIntervalMinutes] = useState(() => (trigger ? triggerInterval(trigger) : defaultTriggerInterval));
  const [full, setFull] = useState(() => (trigger ? triggerRunsFull(code, trigger) : false));
  const [error, setError] = useState("");

  const offersFull = triggerOffersFull(code, kind);
  const watching = kind === "filesystem_event";
  const kindLabel = (value: string) =>
    value === "startup"
      ? t("workflowPage.operations.schedule.startup")
      : value === "filesystem_event"
        ? workflowCopy("whenFoldersChange")
        : t("workflowPage.triggers.onSchedule");

  const save = async () => {
    if (readOnly) return;
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
      setSaving(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("saveFailed"));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!trigger || readOnly) return;
    setSaving(true);
    setError("");
    try {
      await api.deleteWorkflowTrigger(trigger.id);
      setSaving(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : workflowCopy("deleteFailed"));
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
    <>
      <DialogHeader
        icon={<CalendarClock className="h-5 w-5" />}
        title={trigger ? t("workflowPage.triggers.editTitle") : t("workflowPage.triggers.addTitle")}
        onClose={onClose}
      />
      <DialogBody className="workflow-options grid min-w-0 gap-4">
        <fieldset disabled={readOnly || saving} className="m-0 min-w-0 border-0 p-0">
          <RunOptionRows>
            <OptionField label={t("workflowPage.triggers.operation")}>
              <p className="flex min-h-[var(--control-height-sm)] items-center text-sm">{operation.name}</p>
            </OptionField>
            <OptionField
              label={t("workflowPage.triggers.when")}
              hint={
                !trigger && operationTriggerKinds(code).includes("startup") && !kinds.includes("startup")
                  ? t("workflowPage.triggers.startupTaken")
                  : undefined
              }
            >
              {trigger || operationTriggerKinds(code).length < 2 ? (
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
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          {workflowCopy("cancel")}
        </Button>
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={readOnly || saving || (!trigger && !kinds.includes(kind as OperationTriggerKind))}
        >
          <Save className="h-4 w-4" />
          {saving ? workflowCopy("saving") : trigger ? workflowCopy("save") : workflowCopy("addTrigger")}
        </Button>
      </DialogFooter>
    </>
  );
}

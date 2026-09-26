import { CalendarClock, Edit3, Eye, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { presetInputsNeedReconfiguration } from "@/features/workflows/presetWorkflowModel";
import { RelativeTime, WorkflowSection } from "@/features/workflows/WorkflowDetailLayout";
import { parseJSONRecord, workflowCopy } from "@/features/workflows/workflowPageModel";
import {
  supportedAutomationTriggerTypes,
  workflowTriggerCondition,
  workflowTriggerNextRun,
  type AutomationTriggerType,
  type CreatableAutomationTriggerType,
} from "@/features/workflows/workflowTriggerModel";
import type { WorkflowDefinition, WorkflowTrigger } from "@/lib/api";

export function WorkflowAutomationPanel({
  definition,
  isPreset = false,
  triggers,
  canManage,
  readOnly = false,
  onCreate,
  onEdit,
  onToggle,
}: {
  definition: WorkflowDefinition;
  isPreset?: boolean;
  triggers: WorkflowTrigger[];
  canManage: boolean;
  /** Demo keeps trigger controls visible and opens existing triggers read-only. */
  readOnly?: boolean;
  onCreate: (triggerType: CreatableAutomationTriggerType, anchor?: HTMLElement | null) => void;
  onEdit: (trigger: WorkflowTrigger, anchor?: HTMLElement | null) => void;
  onToggle: (trigger: WorkflowTrigger, enabled: boolean) => Promise<void>;
}) {
  const supportedTypes = supportedAutomationTriggerTypes(definition, isPreset);
  const hasStartup = triggers.some((trigger) => trigger.triggerType === "startup");
  const hasSchedule = triggers.some((trigger) => trigger.triggerType === "schedule");
  const orderedTriggers = [...triggers].sort((left, right) => {
    const leftOrder =
      left.triggerType === "startup"
        ? 0
        : left.triggerType === "filesystem_event"
          ? 1
          : left.triggerType === "schedule"
            ? 2
            : 3;
    const rightOrder =
      right.triggerType === "startup"
        ? 0
        : right.triggerType === "filesystem_event"
          ? 1
          : right.triggerType === "schedule"
            ? 2
            : 3;
    return leftOrder - rightOrder || left.id - right.id;
  });
  const canAddStartup = supportedTypes.includes("startup") && !hasStartup;
  const canAddSchedule =
    supportedTypes.includes("schedule") && (definition.code !== "availability_watch" || !hasSchedule);
  return (
    <WorkflowSection
      title={workflowCopy("triggers")}
      label={workflowCopy("workflowAutomations")}
      actions={
        (canManage || readOnly) && supportedTypes.length > 0 ? (
          <>
            {canAddStartup && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={(event) => onCreate("startup", event.currentTarget)}
              >
                <Plus className="h-4 w-4" />
                {workflowCopy("runAtStartup")}
              </Button>
            )}
            {canAddSchedule && (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly}
                onClick={(event) => onCreate("schedule", event.currentTarget)}
              >
                <CalendarClock className="h-4 w-4" />
                {workflowCopy("addSchedule")}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {orderedTriggers.length > 0 ? (
        <ul className="-mx-2">
          {orderedTriggers.map((trigger) => {
            const configurable = supportedTypes.includes(trigger.triggerType as AutomationTriggerType);
            const manageable = canManage && configurable;
            const inspectable = manageable || (readOnly && configurable);
            const openLabel = manageable
              ? `Edit ${trigger.displayName}`
              : workflowCopy("viewTrigger", { name: trigger.displayName });
            const next =
              trigger.enabled && trigger.triggerType === "schedule" && trigger.nextRunAt ? (
                <>
                  {workflowCopy("next")} <RelativeTime value={trigger.nextRunAt} fallback="" />
                </>
              ) : trigger.enabled && trigger.triggerType === "startup" ? null : (
                workflowTriggerNextRun(trigger)
              );
            return (
              <li key={trigger.id} className="flex min-h-11 min-w-0 items-center gap-3 rounded-md px-2 py-1.5">
                <Switch
                  checked={trigger.enabled}
                  disabled={!manageable}
                  onCheckedChange={(enabled) => void onToggle(trigger, enabled)}
                  aria-label={`${trigger.enabled ? workflowCopy("pause") : workflowCopy("enable")} ${trigger.displayName}`}
                />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-sm ${trigger.enabled ? "" : "text-muted-foreground"}`}>
                    {trigger.displayName}
                  </div>
                  <div className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <span>{workflowTriggerCondition(trigger)}</span>
                    {next && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{next}</span>
                      </>
                    )}
                    {trigger.lastSuccessAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {workflowCopy("lastSuccess")} <RelativeTime value={trigger.lastSuccessAt} fallback="" />
                        </span>
                      </>
                    )}
                  </div>
                  {isPreset && presetInputsNeedReconfiguration(parseJSONRecord(trigger.configJson).inputs) ? (
                    <div className="mt-0.5 text-xs text-warning-foreground">
                      {workflowCopy("presetTriggerNeedsReconfiguration")}
                    </div>
                  ) : (
                    trigger.lastErrorMessage && (
                      <div className="mt-0.5 break-words text-xs text-error-foreground [overflow-wrap:anywhere]">
                        {workflowCopy("lastError")}: {trigger.lastErrorMessage}
                      </div>
                    )
                  )}
                </div>
                {inspectable && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    onClick={(event) => onEdit(trigger, event.currentTarget)}
                    title={openLabel}
                    aria-label={openLabel}
                  >
                    {manageable ? <Edit3 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">
          {supportedTypes.length > 0 ? workflowCopy("noAutomaticTriggers") : workflowCopy("noConfigurableTriggers")}
        </p>
      )}
    </WorkflowSection>
  );
}

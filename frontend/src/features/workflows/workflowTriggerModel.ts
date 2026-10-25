import {
  SOURCE_PRESENCE_DEFAULT_LIMIT,
  SOURCE_PRESENCE_MAX_LIMIT,
  configurableSystemWorkflowCodes,
  parseJSONRecord,
  workflowCopy,
  type SystemWorkflowTriggerConfig,
} from "@/features/workflows/workflowPageModel";
import type { WorkflowDefinition, WorkflowTrigger } from "@/lib/api";

/** Automation trigger types per workflow, their summaries, and the system workflow trigger config. */

export type AutomationTriggerType = "startup" | "filesystem_event" | "schedule";
export type CreatableAutomationTriggerType = Exclude<AutomationTriggerType, "filesystem_event">;

const automationTriggerTypes: CreatableAutomationTriggerType[] = ["startup", "schedule"];

export function supportedAutomationTriggerTypes(
  definition: WorkflowDefinition,
  isPreset = false,
): AutomationTriggerType[] {
  // Scheduled catalog sync is a subscription, the subscription refresh runs
  // Availability Watch, and each ranking list keeps its own schedule; all are
  // configured on the Subscriptions page.
  if (definition.scope === "system" && isPreset) return [];
  if (definition.scope === "system" && definition.code === "remote_work_fetch") return [];
  if (definition.scope === "system" && subscriptionsScheduledWorkflowCodes.has(definition.code)) return [];
  if (definition.scope === "system" && definition.code === "local_library_scan")
    return ["startup", "filesystem_event", "schedule"];
  if (definition.scope === "system" && definition.code === "metadata_sync") return ["schedule"];
  if (definition.scope === "system" && configurableSystemWorkflowCodes.has(definition.code))
    return automationTriggerTypes;
  return [];
}

/** Workflows whose automation is configured on the Subscriptions page. */
export const subscriptionsScheduledWorkflowCodes = new Set([
  "availability_watch",
  "creator_subscription_refresh",
  "dlsite_popular_collection",
  "remote_popular_collection",
]);

export function workflowTriggerCondition(trigger: WorkflowTrigger) {
  if (trigger.triggerType === "startup") return workflowCopy("whenServiceStarts");
  if (trigger.triggerType === "filesystem_event") return workflowCopy("whenFoldersChange");
  if (trigger.triggerType === "schedule") {
    const interval = parseJSONRecord(trigger.scheduleJson).intervalMinutes;
    if (typeof interval === "number") return workflowCopy("everyMinutes", { count: interval });
    return workflowCopy("intervalSchedule");
  }
  return trigger.triggerType.replace(/_/g, " ");
}

export function workflowTriggerNextRun(trigger: WorkflowTrigger) {
  if (!trigger.enabled) return workflowCopy("paused");
  if (trigger.triggerType === "startup") return workflowCopy("nextServiceStart");
  if (trigger.triggerType === "filesystem_event") return workflowCopy("watchingFolderChanges");
  return trigger.nextRunAt ?? workflowCopy("pendingCalculation");
}

export function workflowSystemTriggerConfig(
  definitionCode: string,
  trigger: WorkflowTrigger | null,
): SystemWorkflowTriggerConfig {
  const record = parseJSONRecord(trigger?.configJson ?? "");
  return {
    followUpRun: record.followUpRun === true,
    // The local media index trigger stores its mode as `mode`.
    scanMode:
      (definitionCode === "local_media_index" ? record.mode : record.scanMode) === "full" ? "full" : "incremental",
    sourceId: typeof record.sourceId === "number" ? record.sourceId : 0,
    limit: typeof record.limit === "number" ? record.limit : SOURCE_PRESENCE_DEFAULT_LIMIT,
    library: record.library === "all" ? "all" : "local",
    presenceFilter: record.filter === "all" ? "all" : "no_remote_source",
  };
}

export function workflowSystemTriggerConfigPayload(
  definitionCode: string,
  triggerType: AutomationTriggerType,
  value: SystemWorkflowTriggerConfig,
) {
  if (definitionCode === "local_library_scan") {
    return triggerType === "filesystem_event"
      ? { followUpRun: false, scanMode: value.scanMode }
      : { followUpRun: value.followUpRun };
  }
  if (definitionCode === "local_media_index") return { mode: value.scanMode };
  if (definitionCode === "source_presence_check") {
    return { sourceId: value.sourceId, library: value.library, filter: value.presenceFilter, limit: value.limit };
  }
  return {};
}

export function workflowSystemTriggerConfigBlockers(definitionCode: string, value: SystemWorkflowTriggerConfig) {
  if (definitionCode === "source_presence_check") {
    return [
      ...(value.sourceId <= 0 ? [workflowCopy("selectRemoteSource")] : []),
      ...(value.limit <= 0 || value.limit > SOURCE_PRESENCE_MAX_LIMIT
        ? [workflowCopy("sourcePresenceLimitRange", { count: SOURCE_PRESENCE_MAX_LIMIT })]
        : []),
    ];
  }
  return [];
}

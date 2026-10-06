import {
  REMOTE_POPULAR_TAG_TEMPLATE,
  dlsitePopularDefaultTagTemplate,
  workflowTagTemplateBlockers,
} from "@/features/workflows/tagTemplateModel";
import {
  configurableSystemWorkflowCodes,
  parseJSONRecord,
  workflowCopy,
  type DLsitePopularPeriod,
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
  if (definition.scope === "system" && isPreset) return automationTriggerTypes;
  if (definition.scope === "system" && definition.code === "remote_work_fetch") return [];
  if (definition.scope === "system" && definition.code === "availability_watch") return ["schedule"];
  if (definition.scope === "system" && definition.code === "local_library_scan")
    return ["startup", "filesystem_event", "schedule"];
  if (definition.scope === "system" && definition.code === "metadata_sync") return ["schedule"];
  if (definition.scope === "system" && configurableSystemWorkflowCodes.has(definition.code))
    return automationTriggerTypes;
  return [];
}

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
  const period = ["day", "week", "month", "year"].includes(String(record.period))
    ? (record.period as DLsitePopularPeriod)
    : "day";
  const defaultTemplate =
    definitionCode === "dlsite_popular_collection"
      ? dlsitePopularDefaultTagTemplate(period)
      : REMOTE_POPULAR_TAG_TEMPLATE;
  return {
    followUpRun: record.followUpRun === true,
    // The local media index trigger stores its mode as `mode`.
    scanMode:
      (definitionCode === "local_media_index" ? record.mode : record.scanMode) === "full" ? "full" : "incremental",
    sourceId: typeof record.sourceId === "number" ? record.sourceId : 0,
    action: record.action === "fetch" ? "fetch" : "track",
    limit: typeof record.limit === "number" ? record.limit : 25,
    period,
    releaseWindow: record.releaseWindow === "30d" ? "30d" : "",
    year: typeof record.year === "number" ? record.year : new Date().getUTCFullYear(),
    tagNameTemplate:
      typeof record.tagNameTemplate === "string" && record.tagNameTemplate.trim()
        ? record.tagNameTemplate
        : defaultTemplate,
    skipTag: record.skipTag === true,
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
  if (definitionCode === "remote_popular_collection") {
    return {
      sourceId: value.sourceId,
      action: value.action,
      limit: value.limit,
      tagNameTemplate: value.tagNameTemplate.trim(),
      skipTag: value.skipTag,
    };
  }
  if (definitionCode === "dlsite_popular_collection") {
    return {
      period: value.period,
      releaseWindow: value.period === "year" ? "" : value.releaseWindow,
      year: value.period === "year" ? value.year : 0,
      tagNameTemplate: value.tagNameTemplate.trim(),
      skipTag: value.skipTag,
    };
  }
  return {};
}

export function workflowSystemTriggerConfigBlockers(definitionCode: string, value: SystemWorkflowTriggerConfig) {
  if (definitionCode === "remote_popular_collection") {
    return [
      ...(value.sourceId <= 0 ? [workflowCopy("selectRemoteSource")] : []),
      ...(value.action === "fetch" ? [workflowCopy("automatedTrackOnly")] : []),
      ...(value.limit <= 0 || value.limit > 100 ? [workflowCopy("workLimitRange")] : []),
      ...(!value.skipTag
        ? workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "remote_name", "source_code", "action"])
        : []),
    ];
  }
  if (definitionCode === "dlsite_popular_collection") {
    return [
      ...(value.period === "year" && (value.year < 2000 || value.year > new Date().getUTCFullYear())
        ? [workflowCopy("yearRange", { year: new Date().getUTCFullYear() })]
        : []),
      ...(!value.skipTag
        ? workflowTagTemplateBlockers(value.tagNameTemplate, ["date", "period", "release_window", "year"])
        : []),
    ];
  }
  return [];
}

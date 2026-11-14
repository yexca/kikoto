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
  // configured on the Discover page.
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

/**
 * Workflows run and configured on the Discover page, with where each is
 * managed there. Workflows does not list them; Activity keeps their runs.
 */
export const discoverManagedWorkflows: Record<string, { message: string; path: string }> = {
  availability_watch: {
    message: "availabilityWatchManagedOnSubscriptions",
    path: "/discover?view=watch&panel=watch",
  },
  creator_subscription_refresh: {
    message: "subscriptionRefreshManagedOnSubscriptions",
    path: "/discover?panel=subscriptions",
  },
  dlsite_popular_collection: {
    message: "rankingsManagedOnSubscriptions",
    path: "/discover?view=rankings&panel=rankings",
  },
  remote_popular_collection: {
    message: "rankingsManagedOnSubscriptions",
    path: "/discover?view=rankings&panel=rankings",
  },
};

/** Workflows whose automation is configured on the Discover page. */
export const subscriptionsScheduledWorkflowCodes = new Set(Object.keys(discoverManagedWorkflows));

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

export type IntervalParts = { unit: "days" | "hours" | "minutes"; count: number };

/** An interval in minutes as whole days, hours, or minutes, the largest unit that divides it. */
export function intervalParts(minutes: number): IntervalParts {
  if (minutes % 1440 === 0) return { unit: "days", count: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: "hours", count: minutes / 60 };
  return { unit: "minutes", count: minutes };
}

/** How an operation starts on its own, in the words its row uses. */
export type TriggerSummary = {
  startup: boolean;
  watching: boolean;
  /** Interval schedules, as a count of days, hours, or minutes, shortest first. */
  intervals: IntervalParts[];
  /** The soonest next run among the interval schedules. */
  nextRunAt: string | null;
  /** Every trigger is switched off. */
  paused: boolean;
};

/** What an operation's enabled triggers start it on, or null when it has none and runs only by hand. */
export function workflowTriggerSummary(triggers: WorkflowTrigger[]): TriggerSummary | null {
  if (triggers.length === 0) return null;
  const enabled = triggers.filter((trigger) => trigger.enabled);
  const schedules = enabled.filter((trigger) => trigger.triggerType === "schedule");
  const minutes = [
    ...new Set(
      schedules
        .map((trigger) => parseJSONRecord(trigger.scheduleJson).intervalMinutes)
        .filter((value): value is number => typeof value === "number" && value > 0),
    ),
  ].sort((left, right) => left - right);
  const nextRunAt =
    schedules
      .map((trigger) => trigger.nextRunAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  return {
    startup: enabled.some((trigger) => trigger.triggerType === "startup"),
    watching: enabled.some((trigger) => trigger.triggerType === "filesystem_event"),
    intervals: minutes.map(intervalParts),
    nextRunAt,
    paused: enabled.length === 0,
  };
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

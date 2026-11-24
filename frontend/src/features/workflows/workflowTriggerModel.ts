import {
  metadataSyncDefaultValues,
  metadataSyncPayload,
  metadataSyncTriggerValues,
} from "@/features/workflows/metadataSyncModel";
import { parseJSONRecord, workflowCopy } from "@/features/workflows/workflowPageModel";
import type { WorkflowTrigger } from "@/lib/api";

/**
 * Triggers as Workflows shows them: what starts each operation on its own,
 * the order Next lists every workflow's triggers in, and what a trigger the
 * Add dialog saves stores.
 */

/** The trigger kinds the Add dialog creates. Watching folders is the scan's one fixed trigger. */
export type OperationTriggerKind = "startup" | "schedule";

/**
 * Workflows run and configured on Discover, with where each is managed there.
 * Workflows lists their runs and their triggers under Next.
 */
export const pageManagedWorkflows: Record<string, { message: string; path: string }> = {
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

export type IntervalParts = { unit: "days" | "hours" | "minutes"; count: number };

/** An interval in minutes as whole days, hours, or minutes, the largest unit that divides it. */
export function intervalParts(minutes: number): IntervalParts {
  if (minutes % 1440 === 0) return { unit: "days", count: minutes / 1440 };
  if (minutes % 60 === 0) return { unit: "hours", count: minutes / 60 };
  return { unit: "minutes", count: minutes };
}

const intervalKey = {
  minutes: "operations.schedule.everyMinutes",
  hours: "operations.schedule.everyHours",
  days: "operations.schedule.everyDays",
} as const;

/** An interval as "Every 6 hours". */
export function intervalLabel(minutes: number) {
  const parts = intervalParts(minutes);
  return workflowCopy(intervalKey[parts.unit], { count: parts.count });
}

/** Intervals a schedule offers, in minutes: 1, 6, and 12 hours, 1 day, and 7 days. */
export const triggerIntervals = [60, 360, 720, 1440, 10080] as const;
export const defaultTriggerInterval = 1440;

/** The interval choices, keeping a stored interval the list does not offer. */
export function triggerIntervalChoices(current: number): number[] {
  return [...new Set<number>([...triggerIntervals, current])].sort((left, right) => left - right);
}

/** A schedule's interval in minutes, or the default when it stores none. */
export function triggerInterval(trigger: Pick<WorkflowTrigger, "scheduleJson"> | null | undefined): number {
  const value = parseJSONRecord(trigger?.scheduleJson ?? "").intervalMinutes;
  return typeof value === "number" && value > 0 ? value : defaultTriggerInterval;
}

/**
 * A schedule trigger the server plans from elsewhere, such as a ranking pull's
 * dispatcher, which the ranking lists' own schedules plan. It is stored on
 * with no interval, since every schedule saved through the API has one, and
 * runs only while the server has given it a next run.
 */
export function serverPlannedTrigger(trigger: Pick<WorkflowTrigger, "triggerType" | "scheduleJson">) {
  if (trigger.triggerType !== "schedule") return false;
  const interval = parseJSONRecord(trigger.scheduleJson).intervalMinutes;
  return !(typeof interval === "number" && interval > 0);
}

/** The trigger will start its workflow on its own: it is on and, when the server plans it, has a next run. */
export function triggerRunsOnItsOwn(trigger: WorkflowTrigger) {
  return trigger.enabled && (!serverPlannedTrigger(trigger) || Boolean(trigger.nextRunAt));
}

/**
 * When a trigger starts its workflow, as "At startup", "When folders change",
 * or "Every 6 hours"; null for a trigger the server plans, which says only
 * when it runs next.
 */
export function workflowTriggerCondition(trigger: WorkflowTrigger): string | null {
  if (trigger.triggerType === "startup") return workflowCopy("operations.schedule.startup");
  if (trigger.triggerType === "filesystem_event") return workflowCopy("whenFoldersChange");
  if (serverPlannedTrigger(trigger)) return null;
  if (trigger.triggerType === "schedule") return intervalLabel(triggerInterval(trigger));
  return trigger.triggerType.replace(/_/g, " ");
}

/** How an operation starts on its own, in the words its card uses. */
export type TriggerSummary = {
  startup: boolean;
  watching: boolean;
  /** Interval schedules, as a count of days, hours, or minutes, shortest first. */
  intervals: IntervalParts[];
  /** The soonest next run among the interval schedules, as the server states it. */
  nextRunAt: string | null;
  /** Every trigger is switched off. */
  paused: boolean;
};

/**
 * What an operation's enabled triggers start it on, or null when it has none
 * and runs only by hand. `nextRunAt` is the server's soonest next run.
 */
export function workflowTriggerSummary(triggers: WorkflowTrigger[], nextRunAt: string | null): TriggerSummary | null {
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
  return {
    startup: enabled.some((trigger) => trigger.triggerType === "startup"),
    watching: enabled.some((trigger) => trigger.triggerType === "filesystem_event"),
    intervals: minutes.map(intervalParts),
    nextRunAt,
    paused: enabled.length === 0,
  };
}

/**
 * Next's order: interval schedules by their next run, then those still
 * waiting for one, then startup and folder triggers, and paused triggers last.
 */
export function nextTriggerOrder(triggers: WorkflowTrigger[]): WorkflowTrigger[] {
  const rank = (trigger: WorkflowTrigger) => {
    if (!trigger.enabled) return 4;
    if (trigger.triggerType === "schedule") return trigger.nextRunAt ? 0 : 1;
    return trigger.triggerType === "startup" ? 2 : 3;
  };
  const time = (trigger: WorkflowTrigger) => (trigger.nextRunAt ? Date.parse(trigger.nextRunAt) : 0) || 0;
  return [...triggers].sort(
    (left, right) =>
      rank(left) - rank(right) || (rank(left) === 0 ? time(left) - time(right) : 0) || left.id - right.id,
  );
}

/** The kinds Add offers for an operation; metadata sync runs only on a schedule. */
export function operationTriggerKinds(code: string): OperationTriggerKind[] {
  if (code === "metadata_sync") return ["schedule"];
  if (code === "local_library_scan" || code === "local_media_index" || code === "record_media_probe")
    return ["startup", "schedule"];
  return [];
}

/**
 * Whether a trigger can run its operation in full rather than incrementally.
 * A scan at startup or on a schedule always looks at every folder; only
 * watching folders scans just the folders that changed.
 */
export function triggerOffersFull(code: string, triggerType: string) {
  if (code === "local_library_scan") return triggerType === "filesystem_event";
  return code === "local_media_index" || code === "metadata_sync";
}

/** Whether a stored trigger runs its operation in full. */
export function triggerRunsFull(code: string, trigger: Pick<WorkflowTrigger, "triggerType" | "configJson">) {
  const config = parseJSONRecord(trigger.configJson);
  if (code === "local_library_scan") return trigger.triggerType === "filesystem_event" && config.scanMode === "full";
  if (code === "local_media_index" || code === "metadata_sync") return config.mode === "full";
  return false;
}

/**
 * What a trigger stores for its operation. An edited trigger keeps the
 * options Workflows does not show, such as a metadata sync's scope.
 */
export function operationTriggerConfig(
  code: string,
  triggerType: string,
  full: boolean,
  storedConfigJson?: string,
): Record<string, unknown> {
  const stored = storedConfigJson === undefined ? null : parseJSONRecord(storedConfigJson);
  if (code === "local_library_scan")
    return triggerType === "filesystem_event"
      ? { followUpRun: false, scanMode: full ? "full" : "incremental" }
      : { followUpRun: stored?.followUpRun === true };
  if (code === "local_media_index") return { mode: full ? "full" : "incremental" };
  if (code === "metadata_sync")
    return {
      ...(stored ?? metadataSyncPayload(metadataSyncTriggerValues(metadataSyncDefaultValues()))),
      mode: full ? "full" : "missing",
    };
  return stored ?? {};
}

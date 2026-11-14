import {
  parseJSONRecord,
  SOURCE_PRESENCE_DEFAULT_LIMIT,
  SOURCE_PRESENCE_MAX_LIMIT,
} from "@/features/workflows/workflowPageModel";
import {
  defaultTriggerInterval,
  triggerInterval,
  triggerIntervalChoices,
  triggerIntervals,
} from "@/features/workflows/workflowTriggerModel";
import type { SourcePresenceCheckOptions, WorkflowTrigger } from "@/lib/api";

/**
 * A remote source's library work checks as its settings show them: one set of
 * options shared by Run and the automatic checks, and at most one startup and
 * one interval check per source.
 */

export const SOURCE_PRESENCE_CHECK_CODE = "source_presence_check";

/** Intervals an automatic check offers: the ones every schedule offers. */
export const sourceCheckIntervals = triggerIntervals;
export const defaultSourceCheckInterval = defaultTriggerInterval;

export function sourceCheckDefaults(sourceId: number): SourcePresenceCheckOptions {
  return { sourceId, library: "local", filter: "no_remote_source", limit: SOURCE_PRESENCE_DEFAULT_LIMIT };
}

export type SourceCheckTriggers = { startup: WorkflowTrigger[]; schedule: WorkflowTrigger[] };

/** The source's automatic checks by kind; each kind is shown and edited as one. */
export function sourceCheckTriggers(triggers: WorkflowTrigger[], sourceId: number): SourceCheckTriggers {
  const own = triggers.filter(
    (trigger) =>
      trigger.workflowCode === SOURCE_PRESENCE_CHECK_CODE &&
      Number(parseJSONRecord(trigger.configJson).sourceId) === sourceId,
  );
  return {
    startup: own.filter((trigger) => trigger.triggerType === "startup"),
    schedule: own.filter((trigger) => trigger.triggerType === "schedule"),
  };
}

/** The options the source's checks use: those its automatic checks store, otherwise the defaults. */
export function sourceCheckOptions(triggers: SourceCheckTriggers, sourceId: number): SourcePresenceCheckOptions {
  const defaults = sourceCheckDefaults(sourceId);
  const stored = [...triggers.schedule, ...triggers.startup][0];
  if (!stored) return defaults;
  const config = parseJSONRecord(stored.configJson);
  const limit = typeof config.limit === "number" ? config.limit : defaults.limit;
  return {
    sourceId,
    library: config.library === "all" ? "all" : "local",
    filter: config.filter === "all" ? "all" : "no_remote_source",
    limit: limit >= 1 && limit <= SOURCE_PRESENCE_MAX_LIMIT ? limit : defaults.limit,
  };
}

/** A schedule's interval in minutes, or the default when it stores none. */
export function sourceCheckInterval(triggers: WorkflowTrigger[]): number {
  return triggerInterval(triggers[0]);
}

/** The interval choices, keeping a stored interval the list does not offer. */
export const sourceCheckIntervalChoices = triggerIntervalChoices;

/** What an automatic check stores and runs with. */
export function sourceCheckConfigJson(options: SourcePresenceCheckOptions) {
  return JSON.stringify({
    sourceId: options.sourceId,
    library: options.library,
    filter: options.filter,
    limit: options.limit,
  });
}

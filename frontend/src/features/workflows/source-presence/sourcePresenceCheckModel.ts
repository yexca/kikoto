import { triggerIntervalChoices } from "@/features/workflows/workflowTriggerModel";
import type { FileSourcePresenceCheck, SourcePresenceCheckOptions, SourcePresenceCheckSettings } from "@/lib/api";

/**
 * A remote source's library work checks as its settings show them: one set of
 * options shared by Run and the automatic checks, and at most one startup and
 * one interval check per source. The backend stores them and keeps the rule.
 */

/** The interval choices, keeping a stored interval the list does not offer. */
export const sourceCheckIntervalChoices = triggerIntervalChoices;

/**
 * The source's settings with one change applied, saved as a whole. The options
 * are the ones the dialog holds, which Run uses even before an automatic check
 * stores them.
 */
export function sourceCheckSettings(
  check: Pick<FileSourcePresenceCheck, "startup" | "schedule">,
  options: SourcePresenceCheckOptions,
  change: { startup?: boolean; schedule?: boolean; intervalMinutes?: number } = {},
): SourcePresenceCheckSettings {
  return {
    options,
    startup: { enabled: change.startup ?? check.startup.enabled },
    schedule: {
      enabled: change.schedule ?? check.schedule.enabled,
      intervalMinutes: change.intervalMinutes ?? check.schedule.intervalMinutes,
    },
  };
}

/** Why the source's switched-off checks were paused, if they were. */
export function sourceCheckPausedMessage(check: Pick<FileSourcePresenceCheck, "startup" | "schedule">) {
  return check.startup.pausedMessage || check.schedule.pausedMessage || "";
}

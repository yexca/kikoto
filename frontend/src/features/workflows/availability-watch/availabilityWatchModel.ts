import type { AvailabilityWatch, AvailabilityWatchTarget } from "@/lib/api";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { isWorkCode } from "@/lib/workCode";

/** The fewest targets the folded Not available section keeps on a narrow grid. */
const FOLDED_MINIMUM = 6;

/**
 * How many grid slots the folded Not available section fills: whole rows,
 * two of them on a grid with three or more columns and more on a narrower one,
 * so a fold never ends in a partial row.
 */
export function foldedTargetSlots(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.max(2, Math.ceil(FOLDED_MINIMUM / width)) * width;
}

/**
 * Whether the configured action lets this account change the watch: every
 * action needs `metadata:sync`, and Track and Fetch their remote permissions.
 */
export function availabilityWatchActionAllowed(
  action: string,
  canSyncMetadata: boolean,
  canTrackRemote: boolean,
  canFetchRemote: boolean,
) {
  if (!canSyncMetadata) return false;
  if (action === "track") return canTrackRemote;
  if (action === "fetch") return canFetchRemote;
  if (action === "track_fetch") return canTrackRemote && canFetchRemote;
  return true;
}

export type AvailabilityWatchConfig = {
  action: AvailabilityWatch["action"];
  sourceId: number;
  excludeEnabled: boolean;
  excludeExtensions: string[];
};

export function availabilityWatchConfig(watch: AvailabilityWatch): AvailabilityWatchConfig {
  return {
    action: watch.action,
    sourceId: watch.sourceId ?? 0,
    excludeEnabled: watch.excludeExtensions.length > 0,
    excludeExtensions: watch.excludeExtensions,
  };
}

export function availabilityWatchConfigPayload(config: AvailabilityWatchConfig) {
  return {
    action: config.action,
    sourceId: config.sourceId || null,
    excludeExtensions: config.excludeEnabled ? config.excludeExtensions : [],
  };
}

/** Whether the edited configuration differs from what the server would save. */
export function availabilityWatchConfigDirty(config: AvailabilityWatchConfig, watch: AvailabilityWatch): boolean {
  const payload = availabilityWatchConfigPayload(config);
  const saved = [...watch.excludeExtensions].sort().join("\n");
  const edited = [...new Set(payload.excludeExtensions)].sort().join("\n");
  return payload.action !== watch.action || payload.sourceId !== (watch.sourceId ?? null) || edited !== saved;
}

/** A remote source offers some edition of the target's family. */
export function isAvailableTarget(target: AvailabilityWatchTarget): boolean {
  return target.state === "ready" || target.state === "action_queued" || target.state === "completed";
}

/**
 * Splits the active targets by whether a remote source offers their family,
 * keeping the server's order except that failed checks lead the unavailable
 * side, where they need attention.
 */
export function partitionAvailabilityWatchTargets(targets: readonly AvailabilityWatchTarget[]) {
  const failed: AvailabilityWatchTarget[] = [];
  const waiting: AvailabilityWatchTarget[] = [];
  const available: AvailabilityWatchTarget[] = [];
  for (const target of targets) {
    if (target.state === "disabled") continue;
    if (isAvailableTarget(target)) available.push(target);
    else (target.state === "error" ? failed : waiting).push(target);
  }
  return { unavailable: [...failed, ...waiting], available };
}

/** The targets whose configured action, or a manual Track, has completed. */
export function completedAvailabilityWatchTargets(targets: readonly AvailabilityWatchTarget[]) {
  return targets.filter((target) => target.state === "completed");
}

export type QuickAddParseResult = {
  /** New valid codes in input order. */
  codes: string[];
  invalid: string[];
  /** Valid codes already in the pool or repeated in the input. */
  duplicates: number;
};

export function parseQuickAddCodes(input: string, existing: ReadonlySet<string>): QuickAddParseResult {
  const result: QuickAddParseResult = { codes: [], invalid: [], duplicates: 0 };
  const seen = new Set(existing);
  for (const token of input.split(WORD_TOKEN_SEPARATORS)) {
    const code = token.trim().toUpperCase();
    if (!code) continue;
    if (!isWorkCode(code)) result.invalid.push(token.trim());
    else if (seen.has(code)) result.duplicates += 1;
    else {
      seen.add(code);
      result.codes.push(code);
    }
  }
  return result;
}

/** The latest check across the pool, as the server timestamp string. */
export function latestAvailabilityCheck(targets: readonly AvailabilityWatchTarget[]): string {
  return targets.reduce((latest, target) => (target.lastCheckedAt > latest ? target.lastCheckedAt : latest), "");
}

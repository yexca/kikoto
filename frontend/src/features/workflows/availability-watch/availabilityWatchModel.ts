import type { AvailabilityWatch, AvailabilityWatchTarget } from "@/lib/api";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { isWorkCode } from "@/lib/workCode";

/** How many targets each pool column shows before it folds the rest. */
export const POOL_COLUMN_PREVIEW = 12;

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

export function partitionAvailabilityWatchTargets(targets: readonly AvailabilityWatchTarget[]) {
  const unavailable: AvailabilityWatchTarget[] = [];
  const available: AvailabilityWatchTarget[] = [];
  for (const target of targets) {
    if (target.state === "disabled") continue;
    (isAvailableTarget(target) ? available : unavailable).push(target);
  }
  return { unavailable, available };
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

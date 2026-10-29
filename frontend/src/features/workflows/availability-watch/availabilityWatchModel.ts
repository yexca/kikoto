import type { AvailabilityWatchTarget } from "@/lib/api";
import { WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { isCustomWorkCode } from "@/lib/workCode";

/** The fewest targets a folded group keeps on a narrow grid. */
const FOLDED_MINIMUM = 6;

/**
 * How many grid slots a folded group fills: whole rows, two of them on a grid
 * with three or more columns and more on a narrower one, so a fold never ends
 * in a partial row.
 */
export function foldedTargetSlots(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.max(2, Math.ceil(FOLDED_MINIMUM / width)) * width;
}

/** The most works one Track or Fetch request queues; the rest wait for the next. */
export const WATCH_ACTION_MAX_TARGETS = 100;

/**
 * The Watch view's groups, top to bottom: works a source offers, works whose
 * Track or Fetch was started, works no source has yet, failed checks, and
 * works the library already has.
 */
export const WATCH_TARGET_GROUPS = ["available", "inProgress", "waiting", "failed", "inLibrary"] as const;
export type WatchTargetGroup = (typeof WATCH_TARGET_GROUPS)[number];

export type WatchRunKind = "track" | "fetch";
export type WatchRunState = "queued" | "running" | "failed" | "done";

/** A Track or Fetch started for a target, with what its run reports. */
export type WatchTargetRun = { kind: WatchRunKind; runId: number; state: WatchRunState };

export function watchRunState(status: string): WatchRunState | null {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "":
      return null;
    default:
      return "failed";
  }
}

function targetRun(target: AvailabilityWatchTarget, kind: WatchRunKind): WatchTargetRun | null {
  const runId = kind === "fetch" ? target.fetchRunId : target.trackRunId;
  const state = watchRunState(kind === "fetch" ? target.fetchRunStatus : target.trackRunStatus);
  return runId && state ? { kind, runId, state } : null;
}

const activeRun = (run: WatchTargetRun | null) => run?.state === "queued" || run?.state === "running";

/**
 * The run a card reports: a Track or Fetch in progress first, then the Fetch,
 * then the Track.
 */
export function watchTargetRun(target: AvailabilityWatchTarget): WatchTargetRun | null {
  const fetch = targetRun(target, "fetch");
  const track = targetRun(target, "track");
  if (activeRun(fetch)) return fetch;
  if (activeRun(track)) return track;
  return fetch ?? track;
}

/** A remote source offers some edition of the target's family. */
export function isAvailableTarget(target: AvailabilityWatchTarget): boolean {
  return target.state === "ready" && target.availableSourceId !== null;
}

/**
 * Which group a target shows in. A Track or Fetch in progress keeps the
 * target in progress even once files arrive; otherwise the library's files
 * decide, by the same rule as Rankings' "Not in library". A finished or
 * failed run stays in progress until the work is in the library or the
 * target is cleaned up.
 */
export function watchTargetGroup(target: AvailabilityWatchTarget): WatchTargetGroup {
  const run = watchTargetRun(target);
  if (activeRun(run)) return "inProgress";
  if (target.inLibrary) return "inLibrary";
  if (run) return "inProgress";
  if (isAvailableTarget(target)) return "available";
  return target.state === "error" ? "failed" : "waiting";
}

export function groupWatchTargets(targets: readonly AvailabilityWatchTarget[]) {
  const groups: Record<WatchTargetGroup, AvailabilityWatchTarget[]> = {
    available: [],
    inProgress: [],
    waiting: [],
    failed: [],
    inLibrary: [],
  };
  for (const target of targets) {
    if (target.state !== "disabled") groups[watchTargetGroup(target)].push(target);
  }
  return groups;
}

/** What an action on a target needs, so a mixed selection acts only where it applies. */
export type WatchTargetAction = "fetch" | "track" | "check" | "remove";

export function watchTargetAllows(target: AvailabilityWatchTarget, action: WatchTargetAction): boolean {
  switch (action) {
    case "fetch":
    case "track":
      // A failed Track or Fetch can be started again; one in progress cannot.
      return isAvailableTarget(target) && !target.inLibrary && !activeRun(targetRun(target, action));
    case "check":
      // A work the library has needs no source.
      return (target.state === "monitoring" || target.state === "error") && !target.inLibrary;
    case "remove":
      return true;
  }
}

/** The code a Track or Fetch of the target acts on: the edition found, or the watched code. */
export function watchTargetActionCode(target: Pick<AvailabilityWatchTarget, "workCode" | "availableCode">): string {
  return target.availableCode || target.workCode;
}

/** The edition found when it is not the watched code, so a label can name it. */
export function watchTargetOtherEdition(target: Pick<AvailabilityWatchTarget, "workCode" | "availableCode">): string {
  return target.availableCode && target.availableCode !== target.workCode ? target.availableCode : "";
}

/**
 * What Clean up removes: targets the library already has, and targets whose
 * Track or Fetch is done. A target counts once, in the library first.
 */
export function cleanableWatchTargets(targets: readonly AvailabilityWatchTarget[]) {
  const inLibrary: AvailabilityWatchTarget[] = [];
  const done: AvailabilityWatchTarget[] = [];
  for (const target of targets) {
    if (target.state === "disabled") continue;
    if (target.inLibrary) inLibrary.push(target);
    else if (
      !activeRun(watchTargetRun(target)) &&
      (targetRun(target, "fetch")?.state === "done" || targetRun(target, "track")?.state === "done")
    )
      done.push(target);
  }
  return { inLibrary, done };
}

export type WatchCodeParse = {
  /** Codes the pool does not watch yet, in input order. */
  codes: string[];
  /** Codes the pool already watches. */
  watched: string[];
  /** Input that names no work code. */
  invalid: string[];
};

const CODE_IN_TEXT = /(?<![A-Za-z0-9])((?:RJ|BJ|VJ|CC|KT)\d{5,8})(?!\d)/giu;

/**
 * The work codes in pasted text: plain codes, DLsite work URLs, or a mixed
 * list. Each part that holds no code is reported as not a code. Custom codes
 * are not offered by any source, so they are not codes to watch. `existing`
 * holds the watched codes and their editions.
 */
export function parseWatchCodes(input: string, existing: ReadonlySet<string>): WatchCodeParse {
  const result: WatchCodeParse = { codes: [], watched: [], invalid: [] };
  const seen = new Set<string>();
  for (const token of input.split(WORD_TOKEN_SEPARATORS)) {
    const part = token.trim();
    if (!part) continue;
    const found = Array.from(part.matchAll(CODE_IN_TEXT), (match) => match[1].toUpperCase()).filter(
      (code) => !isCustomWorkCode(code),
    );
    if (found.length === 0) {
      result.invalid.push(part);
      continue;
    }
    for (const code of found) {
      if (seen.has(code)) continue;
      seen.add(code);
      (existing.has(code) ? result.watched : result.codes).push(code);
    }
  }
  return result;
}

export type WatchSort = "added" | "release";

/**
 * Orders targets newest first by when they entered the pool or by release
 * date; a target without a known release date sorts after those with one.
 */
export function sortWatchTargets(targets: readonly AvailabilityWatchTarget[], sort: WatchSort) {
  const key = (target: AvailabilityWatchTarget) => (sort === "release" ? target.releaseDate : target.addedAt);
  return [...targets].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    if (a !== b) {
      if (!a) return 1;
      if (!b) return -1;
      return a < b ? 1 : -1;
    }
    return right.id - left.id;
  });
}

/** Whether a target matches a search of the pool by code, edition, or title. */
export function watchTargetMatches(target: AvailabilityWatchTarget, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const fields = [
    target.workCode,
    target.availableCode,
    target.title,
    ...target.family.flatMap((m) => [m.code, m.title]),
  ];
  return fields.some((field) => field.toLowerCase().includes(needle));
}

/** The latest check across the pool, as the server timestamp string. */
export function latestAvailabilityCheck(targets: readonly AvailabilityWatchTarget[]): string {
  return targets.reduce((latest, target) => (target.lastCheckedAt > latest ? target.lastCheckedAt : latest), "");
}

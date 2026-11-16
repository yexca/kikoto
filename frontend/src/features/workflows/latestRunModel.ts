import type { WorkflowRun } from "@/lib/api";

import { isActiveRunStatus } from "./runPresentation";

/**
 * A workflow's newest run as the Discover settings state it: which run, how it
 * stands, and when. Rankings, subscription refresh, and Availability Watch
 * show it alike.
 */
export type LatestRun = {
  id: number;
  status: string;
  /** When it ended, as the server wrote it; null while it is active or when only its id and status are known. */
  at: string | null;
};

/** What a settings endpoint itself reports of a workflow's newest run. */
export type KnownRun = { id: number; status: string; at?: string | null };

/** A listed run's moment: when it ended, or, for an ended run without one, when it began or was queued. */
function runMoment(run: WorkflowRun) {
  if (isActiveRunStatus(run.status)) return null;
  return run.finishedAt || run.startedAt || run.createdAt || null;
}

/**
 * The newest run from the run list and from the settings endpoint, whichever
 * has the higher id: a run just requested is known to the endpoint before the
 * list shows it. `undefined` while neither has answered; `null` when the
 * workflow never ran.
 */
export function mergeLatestRun(
  listed: WorkflowRun | null | undefined,
  known: KnownRun | null | undefined,
): LatestRun | null | undefined {
  if (listed && (!known || listed.id >= known.id)) {
    return { id: listed.id, status: listed.status, at: runMoment(listed) };
  }
  if (known) return { id: known.id, status: known.status, at: known.at ?? null };
  if (listed === null || known === null) return null;
  return undefined;
}

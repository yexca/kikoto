import type { api } from "@/lib/api";

export type RemoteWorkTarget = { sourceId: number; code: string };
export type RemoteBulkAction = "fetch" | "track";

type RemoteBulkRunResult = Awaited<ReturnType<typeof api.recordRemoteBulkRun>>;

/** What one finished bulk run did, as recorded in the run's own summary. */
export type RemoteBulkRunOutcome = { runId: number; fetched: number; synced: number; failed: number };

/** Groups targets by source so each source records one bulk run. */
export function groupRemoteTargetsBySource(targets: readonly RemoteWorkTarget[]) {
  const groups = new Map<number, string[]>();
  for (const target of targets) groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), target.code]);
  return Array.from(groups, ([sourceId, codes]) => ({ sourceId, codes }));
}

/**
 * Describes bulk runs that were just accepted. The server only queues the run
 * at this point, so the works it will process are known and its results are not.
 */
export function summarizeQueuedRemoteBulkRuns(results: readonly Pick<RemoteBulkRunResult, "runId" | "codes">[]) {
  return {
    runId: results[0]?.runId,
    runIds: results.map((result) => `#${result.runId}`).join(", "),
    works: results.reduce((total, result) => total + result.codes.length, 0),
  };
}

/**
 * Reads the result of a finished bulk run from its summary. A run that ended
 * without recording any per-work result failed as a whole, so every work it was
 * queued for counts as failed.
 */
export function remoteBulkRunOutcome(
  run: { id: number; status: string; summaryJson: string },
  queuedWorks: number,
): RemoteBulkRunOutcome {
  let summary: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(run.summaryJson || "{}");
    if (parsed && typeof parsed === "object") summary = parsed as Record<string, unknown>;
  } catch {
    summary = {};
  }
  const count = (key: string) => {
    const value = summary[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  const outcome = { runId: run.id, fetched: count("fetched"), synced: count("synced"), failed: count("failed") };
  const finishedCleanly = run.status === "succeeded" || run.status === "partial";
  if (!finishedCleanly && outcome.fetched + outcome.synced + outcome.failed === 0) outcome.failed = queuedWorks;
  return outcome;
}

export function summarizeRemoteBulkRuns(results: readonly RemoteBulkRunOutcome[]) {
  return {
    runId: results[0]?.runId,
    runIds: results.map((result) => `#${result.runId}`).join(", "),
    fetched: results.reduce((total, result) => total + result.fetched, 0),
    synced: results.reduce((total, result) => total + result.synced, 0),
    failed: results.reduce((total, result) => total + result.failed, 0),
  };
}

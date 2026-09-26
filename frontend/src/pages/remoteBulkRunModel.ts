import type { api } from "@/lib/api";

export type RemoteWorkTarget = { sourceId: number; code: string };
export type RemoteBulkAction = "fetch" | "track";

type RemoteBulkRunResult = Awaited<ReturnType<typeof api.recordRemoteBulkRun>>;

/** Groups targets by source so each source records one bulk run. */
export function groupRemoteTargetsBySource(targets: readonly RemoteWorkTarget[]) {
  const groups = new Map<number, string[]>();
  for (const target of targets) groups.set(target.sourceId, [...(groups.get(target.sourceId) ?? []), target.code]);
  return Array.from(groups, ([sourceId, codes]) => ({ sourceId, codes }));
}

export function summarizeRemoteBulkRuns(
  results: readonly Pick<RemoteBulkRunResult, "runId" | "fetched" | "synced" | "failed">[],
) {
  return {
    runId: results[0]?.runId,
    runIds: results.map((result) => `#${result.runId}`).join(", "),
    fetched: results.reduce((total, result) => total + result.fetched, 0),
    synced: results.reduce((total, result) => total + result.synced, 0),
    failed: results.reduce((total, result) => total + result.failed, 0),
  };
}

import type { RecordActivity, RecordRunActivity } from "@/lib/api";

/**
 * The record workflow state the toolbar shows. `runId` names the workflow run
 * the state comes from; a scan the server refused to queue has none.
 */
export type RecordScanState =
  | { status: "idle" }
  | { status: "queueing" }
  | { status: "queued"; runId: number }
  /** `found` counts the files the walk has found so far. */
  | { status: "running"; runId: number; found: number }
  | { status: "finished"; runId: number }
  | { status: "failed"; runId?: number }
  /** A media details run reads the library; `total` is zero until the run counts them. */
  | { status: "probing"; runId: number; done: number; total: number };

/** What the page asked for: nothing, a scan being queued, a scan it could not queue, or the scan run it follows. */
export type RecordScanRequest =
  { status: "idle" } | { status: "queueing" } | { status: "rejected" } | { status: "following"; runId: number };

export const isActiveRecordRun = (run?: RecordRunActivity) => run?.status === "queued" || run?.status === "running";

const succeeded = (run: RecordRunActivity) => run.status === "succeeded" || run.status === "partial";

/** The state the toolbar shows for a request and what the workflows report. */
export function recordScanState(request: RecordScanRequest, activity: RecordActivity | null): RecordScanState {
  if (request.status === "queueing") return { status: "queueing" };
  if (request.status === "rejected") return { status: "failed" };
  const scan = activity?.scan;
  const followed = request.status === "following" ? request.runId : null;
  // The run this page queued, or a scan someone else started.
  const current = scan && (followed === null ? isActiveRecordRun(scan) : scan.runId >= followed) ? scan : null;
  if (followed !== null && !current) return { status: "queued", runId: followed };
  if (current?.status === "queued") return { status: "queued", runId: current.runId };
  if (current?.status === "running") return { status: "running", runId: current.runId, found: current.progressCurrent };
  if (current && !succeeded(current)) return { status: "failed", runId: current.runId };
  const probe = activity?.probe;
  if (probe && isActiveRecordRun(probe)) {
    return { status: "probing", runId: probe.runId, done: probe.progressCurrent, total: probe.progressTotal };
  }
  if (current) return { status: "finished", runId: current.runId };
  return { status: "idle" };
}

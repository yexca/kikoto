import type { RecordActivity, RecordRunActivity } from "@/lib/api";

/** Inline record workflow state beside the toolbar's Scan action. */
export type RecordScanState =
  | { status: "idle" }
  | { status: "queueing" }
  | { status: "queued" }
  /** `found` counts the files the walk has found so far. */
  | { status: "running"; found: number }
  | { status: "finished" }
  | { status: "failed" }
  /** A media details run reads the library; `total` is zero until the run counts them. */
  | { status: "probing"; done: number; total: number };

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
  if (followed !== null && !current) return { status: "queued" };
  if (current?.status === "queued") return { status: "queued" };
  if (current?.status === "running") return { status: "running", found: current.progressCurrent };
  if (current && !succeeded(current)) return { status: "failed" };
  const probe = activity?.probe;
  if (probe && isActiveRecordRun(probe)) {
    return { status: "probing", done: probe.progressCurrent, total: probe.progressTotal };
  }
  if (current) return { status: "finished" };
  return { status: "idle" };
}

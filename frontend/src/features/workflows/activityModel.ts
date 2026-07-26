import type { WorkflowRun } from "@/lib/api";

export type ActivityView = "running" | "review" | "failed" | "completed";

export function activityViewForRun(run: WorkflowRun): ActivityView {
  if (["queued", "running"].includes(run.status)) return "running";
  if (run.status === "failed") return "failed";
  if (run.pendingCandidates > 0) return "review";
  return "completed";
}

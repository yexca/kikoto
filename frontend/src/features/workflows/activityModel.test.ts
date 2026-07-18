import { describe, expect, it } from "vitest";

import { activityViewForRun } from "./activityModel";
import type { WorkflowRun } from "../../lib/api";

const baseRun = {
  id: 1,
  workflowCode: "test",
  displayName: "Test",
  status: "succeeded",
  triggerType: "manual",
  triggerReason: "test",
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: "",
  finishedAt: "",
  summaryJson: "{}",
  nodeRunCount: 1,
  completedNodeRuns: 1,
  failedNodeRuns: 0,
  skippedNodeRuns: 0,
  jobCount: 1,
  completedJobs: 1,
  failedJobs: 0,
  skippedJobs: 0,
  candidateCount: 0,
  pendingCandidates: 0,
  acceptedCandidates: 0,
  rejectedCandidates: 0,
  reviewedAt: "",
  reviewedByUserId: null,
  definitionId: null,
  triggerId: null,
} satisfies WorkflowRun;

describe("activityViewForRun", () => {
  it("moves an acknowledged partial run to completed without changing its status", () => {
    expect(activityViewForRun({ ...baseRun, status: "partial", reviewedAt: "2026-01-02T00:00:00Z" })).toBe("completed");
  });

  it("keeps pending and unacknowledged signals in review", () => {
    expect(activityViewForRun({ ...baseRun, pendingCandidates: 1 })).toBe("review");
    expect(activityViewForRun({ ...baseRun, skippedNodeRuns: 1 })).toBe("review");
  });

  it("gives failed status precedence over review signals", () => {
    expect(activityViewForRun({ ...baseRun, status: "failed", pendingCandidates: 1 })).toBe("failed");
  });
});

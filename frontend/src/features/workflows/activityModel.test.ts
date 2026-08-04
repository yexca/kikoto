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
  progressBytesCurrent: 0,
  progressBytesTotal: 0,
  progressBytesUnknownItems: 0,
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
  it("keeps informational partial and skipped signals in completed", () => {
    expect(activityViewForRun({ ...baseRun, status: "partial" })).toBe("completed");
    expect(activityViewForRun({ ...baseRun, status: "skipped", skippedNodeRuns: 1 })).toBe("completed");
    expect(activityViewForRun({ ...baseRun, skippedJobs: 1 })).toBe("completed");
  });

  it("keeps terminal runs with pending candidates in review", () => {
    expect(activityViewForRun({ ...baseRun, pendingCandidates: 1 })).toBe("review");
  });

  it("gives active and failed statuses precedence over review candidates", () => {
    expect(activityViewForRun({ ...baseRun, status: "running", pendingCandidates: 1 })).toBe("running");
    expect(activityViewForRun({ ...baseRun, status: "failed", pendingCandidates: 1 })).toBe("failed");
  });
});

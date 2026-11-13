import { describe, expect, it } from "vitest";

import type { WorkflowDefinition, WorkflowRun } from "@/lib/api";

import {
  activeRunProgress,
  groupOperations,
  operationBusy,
  operationState,
  operationsFromDefinitions,
} from "./operationModel";

function definition(id: number, code: string): WorkflowDefinition {
  return {
    id,
    code,
    displayName: code,
    description: "",
    definitionJson: "{}",
    scope: "system",
    editable: false,
    ownerUserId: null,
    triggerCount: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function run(overrides: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 1,
    workflowCode: "local_library_scan",
    displayName: "",
    status: "succeeded",
    triggerType: "manual",
    triggerReason: "",
    createdAt: "",
    startedAt: "",
    finishedAt: "",
    summaryJson: "{}",
    nodeRunCount: 0,
    completedNodeRuns: 0,
    failedNodeRuns: 0,
    skippedNodeRuns: 0,
    jobCount: 0,
    completedJobs: 0,
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
    ...overrides,
  };
}

describe("operations", () => {
  it("lists what is started by hand, grouped by purpose, and leaves out workflows run elsewhere", () => {
    const operations = operationsFromDefinitions(
      [
        definition(1, "availability_watch"),
        definition(2, "source_presence_check"),
        definition(3, "voice_catalog_sync"),
        definition(4, "metadata_sync"),
        definition(5, "metadata_genre_names"),
        definition(6, "local_library_scan"),
        definition(7, "remote_work_fetch"),
      ],
      new Set(["voice_catalog_sync"]),
    );
    expect(
      groupOperations(operations).map((entry) => [entry.group, entry.operations.map((item) => item.definition.code)]),
    ).toEqual([
      ["library", ["local_library_scan", "metadata_sync"]],
      ["catalog", ["voice_catalog_sync"]],
      ["remote", ["remote_work_fetch", "source_presence_check"]],
    ]);
    // Only an operation with nothing to fill in runs straight from its row.
    expect(operations.filter((item) => item.defaults).map((item) => item.definition.code)).toEqual([
      "local_library_scan",
      "metadata_sync",
    ]);
  });
});

describe("operationState", () => {
  it("waits for the latest run before saying an operation never ran", () => {
    expect(operationState(undefined, undefined).phase).toBe("loading");
    expect(operationState(null, undefined).phase).toBe("never");
  });

  it("holds an operation from the request until the run it created ends", () => {
    const previous = run({ id: 7, status: "failed" });
    // Requested, not answered yet; then answered, with the list still showing the previous run.
    expect(operationBusy(operationState(previous, { runId: null }))).toBe(true);
    expect(operationState(previous, { runId: 8 }).phase).toBe("starting");
    expect(operationState(run({ id: 8, status: "queued" }), { runId: 8 }).phase).toBe("queued");
    expect(operationBusy(operationState(run({ id: 8, status: "running" }), { runId: 8 }))).toBe(true);
    const finished = operationState(run({ id: 8, status: "succeeded" }), { runId: 8 });
    expect(finished.phase).toBe("finished");
    expect(operationBusy(finished)).toBe(false);
  });

  it("keeps a failure and an outcome that waits for review on the operation", () => {
    expect(operationState(run({ status: "failed" }), undefined)).toMatchObject({ tone: "error", review: false });
    expect(operationState(run({ status: "partial", pendingCandidates: 2 }), undefined)).toMatchObject({
      tone: "warning",
      review: true,
    });
  });
});

describe("activeRunProgress", () => {
  it("counts jobs for a bulk run and stages otherwise", () => {
    expect(activeRunProgress(run({ status: "running", jobCount: 40, completedJobs: 12 }), 3)).toEqual({
      current: 12,
      total: 40,
      unit: "jobs",
    });
    expect(activeRunProgress(run({ status: "running", nodeRunCount: 2, completedNodeRuns: 1 }), 4)).toEqual({
      current: 2,
      total: 4,
      unit: "steps",
    });
    expect(activeRunProgress(run({ status: "queued" }), 4)).toBeNull();
  });
});

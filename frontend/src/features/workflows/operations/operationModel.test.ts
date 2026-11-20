import { describe, expect, it } from "vitest";

import type { WorkflowDefinition, WorkflowRun, WorkflowStatus } from "@/lib/api";

import {
  activeRunProgress,
  operationBusy,
  operationLocked,
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

function status(
  currentRun: WorkflowRun | null,
  needsReview = false,
): Pick<WorkflowStatus, "currentRun" | "needsReview"> {
  return { currentRun, needsReview };
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
  it("lists Scan, Metadata, and Index in that order and leaves out workflows run elsewhere", () => {
    // Fetch runs from a work, a catalog sync from its circle, series, or voice
    // actor, and a source's library work check from its settings.
    const operations = operationsFromDefinitions([
      definition(1, "availability_watch"),
      definition(2, "source_presence_check"),
      definition(3, "voice_catalog_sync"),
      definition(4, "metadata_sync"),
      definition(5, "metadata_genre_names"),
      definition(6, "local_library_scan"),
      definition(7, "remote_work_fetch"),
      definition(8, "local_media_index"),
    ]);
    expect(operations.map((item) => item.definition.code)).toEqual([
      "local_library_scan",
      "metadata_sync",
      "local_media_index",
    ]);
  });
});

describe("operationState", () => {
  it("waits for the latest run before saying an operation never ran", () => {
    expect(operationState(undefined, undefined).phase).toBe("loading");
    expect(operationState(status(null), undefined).phase).toBe("never");
  });

  it("holds an operation from the request until the run it created ends", () => {
    const previous = run({ id: 7, status: "failed" });
    // Requested, not answered yet; then answered, with the list still showing the previous run.
    expect(operationBusy(operationState(status(previous), { runId: null }))).toBe(true);
    expect(operationState(status(previous), { runId: 8 }).phase).toBe("starting");
    expect(operationState(status(run({ id: 8, status: "queued" })), { runId: 8 }).phase).toBe("queued");
    expect(operationBusy(operationState(status(run({ id: 8, status: "running" })), { runId: 8 }))).toBe(true);
    const finished = operationState(status(run({ id: 8, status: "succeeded" })), { runId: 8 });
    expect(finished.phase).toBe("finished");
    expect(operationBusy(finished)).toBe(false);
  });

  it("keeps a failure and an outcome that waits for review on the operation", () => {
    expect(operationState(status(run({ status: "failed" })), undefined)).toMatchObject({
      tone: "error",
      review: false,
    });
    expect(operationState(status(run({ status: "partial" }), true), undefined)).toMatchObject({
      tone: "warning",
      review: true,
    });
  });
});

describe("operationLocked", () => {
  const operations = operationsFromDefinitions([
    definition(1, "local_library_scan"),
    definition(2, "local_media_index"),
    definition(3, "metadata_sync"),
  ]);
  const byCode = (code: string) => operations.find((item) => item.definition.code === code)!;
  const running = operationState(status(run({ id: 8, status: "running" })), undefined);

  it("holds a library-wide operation until its run ends", () => {
    expect(operationLocked(byCode("local_library_scan"), running)).toBe(true);
    expect(
      operationLocked(byCode("local_media_index"), operationState(status(run({ status: "queued" })), undefined)),
    ).toBe(true);
  });

  it("lets an operation that runs per target start another target while one runs", () => {
    const metadataSync = byCode("metadata_sync");
    expect(operationLocked(metadataSync, running)).toBe(false);
    // A click holds it only until the run it requested is listed.
    expect(
      operationLocked(metadataSync, operationState(status(run({ id: 8, status: "running" })), { runId: null })),
    ).toBe(true);
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

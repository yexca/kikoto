import { describe, expect, it } from "vitest";

import {
  groupRemoteTargetsBySource,
  remoteBulkRunOutcome,
  summarizeQueuedRemoteBulkRuns,
  summarizeRemoteBulkRuns,
} from "@/pages/remoteBulkRunModel";

describe("remote bulk runs", () => {
  it("records one run per source in the order sources first appear", () => {
    expect(
      groupRemoteTargetsBySource([
        { sourceId: 2, code: "RJ00000001" },
        { sourceId: 1, code: "RJ00000002" },
        { sourceId: 2, code: "RJ00000003" },
      ]),
    ).toEqual([
      { sourceId: 2, codes: ["RJ00000001", "RJ00000003"] },
      { sourceId: 1, codes: ["RJ00000002"] },
    ]);
  });

  it("combines per-source results into one summary", () => {
    expect(
      summarizeRemoteBulkRuns([
        { runId: 11, fetched: 2, synced: 0, failed: 1 },
        { runId: 12, fetched: 1, synced: 3, failed: 0 },
      ]),
    ).toEqual({ runId: 11, runIds: "#11, #12", fetched: 3, synced: 3, failed: 1 });
  });

  it("reports accepted runs by the works they were queued for, not by results that do not exist yet", () => {
    // The enqueue response of a bulk run: queued, with every counter still zero.
    const accepted = [
      {
        runId: 11,
        sourceId: 2,
        action: "fetch",
        codes: ["RJ00000001", "RJ00000003"],
        status: "queued",
        synced: 0,
        fetched: 0,
        failed: 0,
        failures: [],
        childRuns: [],
      },
      {
        runId: 12,
        sourceId: 1,
        action: "fetch",
        codes: ["RJ00000002"],
        status: "queued",
        synced: 0,
        fetched: 0,
        failed: 0,
        failures: [],
        childRuns: [],
      },
    ];

    expect(summarizeQueuedRemoteBulkRuns(accepted)).toEqual({ runId: 11, runIds: "#11, #12", works: 3 });
  });

  it("reads a finished run's result from its summary", () => {
    const summaryJson = JSON.stringify({
      action: "fetch",
      synced: 0,
      fetched: 2,
      failed: 1,
      failures: ["RJ00000003: x"],
    });

    expect(remoteBulkRunOutcome({ id: 11, status: "partial", summaryJson }, 3)).toEqual({
      runId: 11,
      fetched: 2,
      synced: 0,
      failed: 1,
    });
  });

  it("counts every queued work as failed when the run ended without recording a result", () => {
    expect(remoteBulkRunOutcome({ id: 11, status: "failed", summaryJson: "{}" }, 3)).toEqual({
      runId: 11,
      fetched: 0,
      synced: 0,
      failed: 3,
    });
    expect(remoteBulkRunOutcome({ id: 12, status: "cancelled", summaryJson: "not json" }, 2).failed).toBe(2);
  });
});

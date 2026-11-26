import { describe, expect, it } from "vitest";

import type { RecordActivity } from "@/lib/api";

import { recordScanState } from "./recordScanModel";

const idle = { status: "idle" } as const;
const following = (runId: number) => ({ status: "following", runId }) as const;
const activity = (value: Partial<RecordActivity>): RecordActivity => ({ pendingFiles: 0, ...value });
const run = (runId: number, status: string, progressCurrent = 0, progressTotal = 0) => ({
  runId,
  status,
  progressCurrent,
  progressTotal,
});

describe("recordScanState", () => {
  it("follows a queued scan until the root reports its run", () => {
    // The root still names the previous, finished scan.
    expect(recordScanState(following(8), activity({ scan: run(7, "succeeded") }))).toEqual({
      status: "queued",
      runId: 8,
    });
    expect(recordScanState(following(8), activity({ scan: run(8, "running", 120) }))).toEqual({
      status: "running",
      runId: 8,
      found: 120,
    });
    expect(recordScanState(following(8), activity({ scan: run(8, "failed") }))).toEqual({
      status: "failed",
      runId: 8,
    });
    expect(recordScanState({ status: "rejected" }, null)).toEqual({ status: "failed" });
  });

  it("shows a media details run active after a finished scan, then the finished scan", () => {
    const finished = run(8, "succeeded", 1775, 1775);
    expect(recordScanState(following(8), activity({ scan: finished, probe: run(9, "running", 40, 1775) }))).toEqual({
      status: "probing",
      runId: 9,
      done: 40,
      total: 1775,
    });
    expect(recordScanState(following(8), activity({ scan: finished }))).toEqual({ status: "finished", runId: 8 });
  });

  it("shows work started elsewhere and stays idle once nothing runs", () => {
    expect(recordScanState(idle, activity({ scan: run(3, "running", 5) }))).toEqual({
      status: "running",
      runId: 3,
      found: 5,
    });
    expect(recordScanState(idle, activity({ scan: run(3, "succeeded"), probe: run(4, "queued") }))).toEqual({
      status: "probing",
      runId: 4,
      done: 0,
      total: 0,
    });
    expect(recordScanState(idle, activity({ scan: run(3, "failed") }))).toEqual({ status: "idle" });
    expect(recordScanState(idle, null)).toEqual({ status: "idle" });
  });
});

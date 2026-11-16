import { describe, expect, it } from "vitest";

import type { WorkflowRun } from "@/lib/api";

import { mergeLatestRun } from "./latestRunModel";

function run(
  id: number,
  status: string,
  times: Partial<Pick<WorkflowRun, "createdAt" | "startedAt" | "finishedAt">> = {},
) {
  return { id, status, createdAt: "", startedAt: "", finishedAt: "", ...times } as WorkflowRun;
}

describe("mergeLatestRun", () => {
  it("is unknown until a source answers and never run when one says so", () => {
    expect(mergeLatestRun(undefined, undefined)).toBeUndefined();
    expect(mergeLatestRun(null, undefined)).toBeNull();
    expect(mergeLatestRun(undefined, null)).toBeNull();
  });

  it("times an ended run by its end, then its start, then when it was queued", () => {
    expect(mergeLatestRun(run(3, "succeeded", { createdAt: "a", startedAt: "b", finishedAt: "c" }), undefined)).toEqual(
      {
        id: 3,
        status: "succeeded",
        at: "c",
      },
    );
    expect(mergeLatestRun(run(4, "failed", { createdAt: "a", startedAt: "b" }), undefined)?.at).toBe("b");
    expect(mergeLatestRun(run(5, "failed", { createdAt: "a" }), undefined)?.at).toBe("a");
  });

  it("gives an active run no time", () => {
    expect(mergeLatestRun(run(6, "running", { createdAt: "a", startedAt: "b" }), undefined)?.at).toBeNull();
    expect(mergeLatestRun(run(7, "queued", { createdAt: "a" }), undefined)?.at).toBeNull();
  });

  it("prefers a run the list has not caught up to", () => {
    expect(mergeLatestRun(run(7, "succeeded", { finishedAt: "x" }), { id: 8, status: "queued" })).toEqual({
      id: 8,
      status: "queued",
      at: null,
    });
  });

  it("prefers the listed run once it is as new, for its time and current status", () => {
    expect(mergeLatestRun(run(8, "failed", { finishedAt: "x" }), { id: 8, status: "running" })).toEqual({
      id: 8,
      status: "failed",
      at: "x",
    });
  });

  it("keeps what the endpoint knows when the run list is out of reach", () => {
    expect(mergeLatestRun(undefined, { id: 2, status: "failed", at: "t" })).toEqual({
      id: 2,
      status: "failed",
      at: "t",
    });
  });
});

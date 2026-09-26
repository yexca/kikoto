import { describe, expect, it } from "vitest";

import { groupRemoteTargetsBySource, summarizeRemoteBulkRuns } from "@/pages/remoteBulkRunModel";

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
});

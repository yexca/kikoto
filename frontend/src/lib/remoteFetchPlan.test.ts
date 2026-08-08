import { describe, expect, it } from "vitest";

import type { RemoteWorkSavePlan } from "./api";
import { formatRemoteFetchPlanConflict, hasRemoteFetchConflicts } from "./remoteFetchPlan";

describe("remote Fetch plan conflicts", () => {
  it("reports a Fetch-root ownership conflict without a synthetic file item", () => {
    const plan: RemoteWorkSavePlan = {
      sourceId: 7,
      primaryCode: "RJ00000000",
      saveRoot: "example_remote_a/RJ/000/RJ00000000",
      fetchRoot: {
        rootPath: "example_remote_a",
        status: "conflict",
        conflict: true,
        message: "This Fetch folder already exists and is not managed by Kikoto.",
      },
      localFiles: [],
      items: [],
      summary: { total: 0, skipExisting: 0, cacheHit: 0, cacheDownload: 0, promote: 0, conflict: 1 },
      preparation: {
        requestedCode: "RJ00000000",
        canonicalCode: "RJ00000000",
        metadataStatus: "complete",
        warnings: [],
        editions: [],
      },
    };

    expect(hasRemoteFetchConflicts(plan)).toBe(true);
    expect(formatRemoteFetchPlanConflict(plan)).toContain("example_remote_a");
    expect(formatRemoteFetchPlanConflict(plan)).toContain("not managed by Kikoto");
  });
});

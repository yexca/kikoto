import { describe, expect, it } from "vitest";

import type { AvailabilityWatch, AvailabilityWatchTarget } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";
import {
  availabilityWatchConfig,
  availabilityWatchConfigDirty,
  partitionAvailabilityWatchTargets,
  parseQuickAddCodes,
} from "./availabilityWatchModel";

const watch: AvailabilityWatch = {
  id: 1,
  action: "track",
  sourceId: null,
  excludeExtensions: ["wav"],
  revision: 1,
  targets: [],
};

function target(index: number, state: AvailabilityWatchTarget["state"]): AvailabilityWatchTarget {
  return {
    id: index,
    workCode: syntheticWorkCode("RJ", index),
    title: "",
    coverUrl: "",
    state,
    nextCheckAt: "",
    lastCheckedAt: "",
    lastStatus: "",
    lastError: "",
    availableSourceId: null,
    availableCode: "",
    trackRunId: null,
    fetchRunId: null,
    family: [],
  };
}

describe("availability watch configuration", () => {
  it("is clean until an edit changes what the server would save", () => {
    const config = availabilityWatchConfig(watch);
    expect(availabilityWatchConfigDirty(config, watch)).toBe(false);
    expect(availabilityWatchConfigDirty({ ...config, action: "monitor" }, watch)).toBe(true);
    expect(availabilityWatchConfigDirty({ ...config, excludeEnabled: false }, watch)).toBe(true);
    // Turning exclusion on without an extension still saves nothing to exclude.
    const unconfigured = { ...watch, excludeExtensions: [] };
    const enabled = { ...availabilityWatchConfig(unconfigured), excludeEnabled: true };
    expect(availabilityWatchConfigDirty(enabled, unconfigured)).toBe(false);
  });
});

describe("availability watch pool", () => {
  it("splits active targets into unavailable and available families", () => {
    const pool = partitionAvailabilityWatchTargets([
      target(0, "monitoring"),
      target(1, "error"),
      target(2, "ready"),
      target(3, "completed"),
      target(4, "disabled"),
    ]);
    expect(pool.unavailable.map((item) => item.id)).toEqual([0, 1]);
    expect(pool.available.map((item) => item.id)).toEqual([2, 3]);
  });

  it("adds only new valid codes from pasted input", () => {
    const existing = syntheticWorkCode("RJ", 0);
    const added = syntheticWorkCode("RJ", 1);
    const result = parseQuickAddCodes(`${existing.toLowerCase()}, ${added}；${added} nope`, new Set([existing]));
    expect(result).toEqual({ codes: [added], invalid: ["nope"], duplicates: 2 });
  });
});

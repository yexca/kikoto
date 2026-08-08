import { describe, expect, it } from "vitest";

import { syntheticWorkCode, syntheticWorkCodeAt } from "./workCode";

describe("synthetic work-code fixtures", () => {
  it.each([
    ["RJ", "RJ00000007"],
    ["BJ", "BJ00000007"],
    ["VJ", "VJ00000007"],
    ["CC", "CC00000007"],
  ] as const)("constructs the reserved %s range", (prefix, expected) => {
    expect(syntheticWorkCode(prefix, 7)).toBe(expected);
  });

  it("spans reserved prefix ranges for high-cardinality fixtures", () => {
    expect(syntheticWorkCodeAt(0)).toBe("RJ00000000");
    expect(syntheticWorkCodeAt(99)).toBe("RJ00000099");
    expect(syntheticWorkCodeAt(100)).toBe("BJ00000000");
    expect(syntheticWorkCodeAt(399)).toBe("CC00000099");
  });

  it("rejects values outside the reserved ranges", () => {
    expect(() => syntheticWorkCode("RJ", -1)).toThrow(RangeError);
    expect(() => syntheticWorkCode("RJ", 100)).toThrow(RangeError);
    expect(() => syntheticWorkCodeAt(400)).toThrow(RangeError);
  });
});

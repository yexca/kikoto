import { describe, expect, it } from "vitest";

import { isWorkCode, isWorkCodePath } from "./workCode";

describe("work-code validation", () => {
  it.each(["RJ00000", "BJ000000", "VJ0000000", "CC00000000"])("accepts supported code %s", (code) => {
    expect(isWorkCode(code)).toBe(true);
    expect(isWorkCodePath(`/${code}`)).toBe(true);
  });

  it.each(["RJ0000", "BJ000000000", "ZZ00000000", "RJ-00000000"])("rejects unsupported code %s", (code) => {
    expect(isWorkCode(code)).toBe(false);
    expect(isWorkCodePath(`/${code}`)).toBe(false);
  });
});

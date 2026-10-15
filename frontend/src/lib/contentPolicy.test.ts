import { describe, expect, it } from "vitest";

import { serviceReceives, type ContentClass, type ContentMaximum } from "./contentPolicy";

describe("service receive maxima", () => {
  const cases: Array<[ContentClass, boolean[]]> = [
    ["safe", [true, true, true]],
    ["sensitive", [false, true, true]],
    ["restricted", [false, false, true]],
    ["unknown", [false, false, false]],
    ["blocked", [false, false, false]],
  ];
  it.each(cases)("routes %s by the explicit maximum", (contentClass, expected) => {
    const maxima: ContentMaximum[] = ["safe", "sensitive", "restricted"];
    expect(maxima.map((maxContentClass) => serviceReceives(contentClass, { maxContentClass }))).toEqual(expected);
  });
  it("refuses invalid or missing receive maxima even for general content", () => {
    expect(serviceReceives("safe", { maxContentClass: "unknown" as ContentMaximum })).toBe(false);
    expect(serviceReceives("safe", {} as { maxContentClass: ContentMaximum })).toBe(false);
  });
});

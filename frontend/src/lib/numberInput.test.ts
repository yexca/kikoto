import { describe, expect, it } from "vitest";

import { wholeNumberFromInput } from "./numberInput";

describe("wholeNumberFromInput", () => {
  it("keeps whole numbers and drops a typed fraction", () => {
    expect(wholeNumberFromInput("12")).toBe(12);
    expect(wholeNumberFromInput("1.5")).toBe(1);
    expect(wholeNumberFromInput("0.9")).toBe(0);
    expect(wholeNumberFromInput("-2.7")).toBe(-2);
    expect(wholeNumberFromInput("1e2")).toBe(100);
  });

  it("leaves unparseable text for the caller to reject", () => {
    expect(wholeNumberFromInput("abc")).toBeNaN();
    expect(wholeNumberFromInput("")).toBe(0);
  });
});

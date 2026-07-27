import { describe, expect, it } from "vitest";

import { parseWorkCodes } from "./WorkCodesField";

describe("parseWorkCodes", () => {
  it("accepts documented ASCII and full-width separators", () => {
    expect(parseWorkCodes("rj01234567; BJ1234，VJ12345\nCC123456")).toEqual({
      codes: ["RJ01234567", "BJ1234", "VJ12345", "CC123456"],
      duplicates: [],
      invalid: [],
    });
  });

  it("reports duplicate and invalid tokens without hiding valid codes", () => {
    expect(parseWorkCodes("RJ01234567 RJ01234567 nope")).toEqual({
      codes: ["RJ01234567"],
      duplicates: ["RJ01234567"],
      invalid: ["nope"],
    });
  });
});

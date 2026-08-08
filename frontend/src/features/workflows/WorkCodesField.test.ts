import { describe, expect, it } from "vitest";

import { syntheticWorkCode } from "@/test-support/workCode";
import { parseWorkCodes } from "./WorkCodesField";

describe("parseWorkCodes", () => {
  it("accepts documented ASCII and full-width separators", () => {
    const codes = [
      syntheticWorkCode("RJ", 0),
      syntheticWorkCode("BJ", 0),
      syntheticWorkCode("VJ", 0),
      syntheticWorkCode("CC", 0),
    ];
    expect(parseWorkCodes(`${codes[0].toLowerCase()}; ${codes[1]}，${codes[2]}\n${codes[3]}`)).toEqual({
      codes,
      duplicates: [],
      invalid: [],
    });
  });

  it("reports duplicate and invalid tokens without hiding valid codes", () => {
    const code = syntheticWorkCode("RJ", 0);
    expect(parseWorkCodes(`${code} ${code} RJ0000 nope`)).toEqual({
      codes: [code],
      duplicates: [code],
      invalid: ["RJ0000", "nope"],
    });
  });
});

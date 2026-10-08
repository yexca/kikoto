import { describe, expect, it } from "vitest";

import { appendTokens, splitTokenDraft, WORD_TOKEN_SEPARATORS } from "@/lib/tokenDraft";
import { syntheticWorkCode } from "@/test-support/workCode";
import { normalizeWorkCodeToken, parseWorkCodes } from "./WorkCodesField";

describe("work code tokens", () => {
  it("accepts documented ASCII and full-width separators", () => {
    const codes = [
      syntheticWorkCode("RJ", 0),
      syntheticWorkCode("BJ", 0),
      syntheticWorkCode("VJ", 0),
      syntheticWorkCode("CC", 0),
    ];
    const pasted = `${codes[0].toLowerCase()}; ${codes[1]}，${codes[2]}\n${codes[3]} `;
    const { tokens } = splitTokenDraft(pasted, WORD_TOKEN_SEPARATORS);
    expect(appendTokens([], tokens, normalizeWorkCodeToken)).toEqual(codes);
  });

  it("drops duplicates and keeps invalid tokens visible next to valid codes", () => {
    const code = syntheticWorkCode("RJ", 0);
    const values = appendTokens([code], [code.toLowerCase(), "RJ0000", "nope"], normalizeWorkCodeToken);
    expect(parseWorkCodes(values)).toEqual({ codes: [code], invalid: ["RJ0000", "NOPE"] });
  });
});

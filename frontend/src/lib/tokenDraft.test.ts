import { describe, expect, it } from "vitest";

import { appendTokens, splitTokenDraft } from "./tokenDraft";

describe("splitTokenDraft", () => {
  it("keeps text without a separator as the draft", () => {
    expect(splitTokenDraft("ASMR voice")).toEqual({ tokens: [], rest: "ASMR voice" });
  });

  it("finishes every token before the last separator and keeps the rest editable", () => {
    expect(splitTokenDraft("night, 安眠，耳かき、 rain; bin")).toEqual({
      tokens: ["night", "安眠", "耳かき", "rain"],
      rest: "bin",
    });
  });

  it("drops empty tokens between repeated separators", () => {
    expect(splitTokenDraft(" , night,,\n")).toEqual({ tokens: ["night"], rest: "" });
  });
});

describe("appendTokens", () => {
  it("adds new tokens in order and skips case-insensitive duplicates", () => {
    expect(appendTokens(["Night"], ["night", "Rain", "rain", " "])).toEqual(["Night", "Rain"]);
  });
});

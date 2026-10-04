import { describe, expect, it } from "vitest";
import { surfaceEnglish } from "./en";
import { surfaceJapanese } from "./ja";
import { surfaceKorean } from "./ko";
import { surfaceHans } from "./zh-Hans";
import { surfaceHant } from "./zh-Hant";

describe("Metadata voice actor labels", () => {
  it.each([
    [surfaceEnglish, "Voice actors"],
    [surfaceJapanese, "声優"],
    [surfaceKorean, "성우"],
    [surfaceHans, "声优"],
    [surfaceHant, "聲優"],
  ] as const)("uses the voice actor name for the existing aliases view", (surface, name) => {
    expect(surface.workManagement.voiceAliases).toBe(name);
    expect(surface.workManagement.voiceAliasesTitle).toBe(name);
  });
});

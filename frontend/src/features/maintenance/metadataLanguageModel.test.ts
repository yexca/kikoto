import { describe, expect, it } from "vitest";

import {
  moveDlsiteMetadataLanguage,
  moveDlsiteMetadataLanguageTo,
  normalizeDlsiteMetadataLanguages,
} from "@/features/maintenance/metadataLanguageModel";

describe("DLsite metadata language priority", () => {
  it("normalizes selected languages, removes duplicates, and defaults to origin", () => {
    expect(normalizeDlsiteMetadataLanguages(["en-us", "en-us", "unknown"])).toEqual(["en-us", "origin"]);
    expect(normalizeDlsiteMetadataLanguages([])).toEqual(["origin"]);
  });

  it("moves a language earlier or later without mutating the input", () => {
    const languages = ["ja-jp", "en-us", "zh-cn", "origin"] as const;
    expect(moveDlsiteMetadataLanguage(languages, 1, -1)).toEqual(["en-us", "ja-jp", "zh-cn", "origin"]);
    expect(moveDlsiteMetadataLanguageTo(languages, 0, 2)).toEqual(["en-us", "zh-cn", "ja-jp", "origin"]);
    expect(languages).toEqual(["ja-jp", "en-us", "zh-cn", "origin"]);
  });

  it("keeps origin last and immovable", () => {
    const languages = normalizeDlsiteMetadataLanguages(["origin", "zh-cn"]);
    expect(languages).toEqual(["zh-cn", "origin"]);
    expect(moveDlsiteMetadataLanguage(languages, languages.length - 1, -1)).toEqual(languages);
    expect(moveDlsiteMetadataLanguageTo(languages, 0, languages.length - 1)).toEqual(languages);
  });
});

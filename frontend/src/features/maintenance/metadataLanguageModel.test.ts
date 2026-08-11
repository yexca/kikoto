import { describe, expect, it } from "vitest";

import {
  moveDlsiteMetadataLanguage,
  moveDlsiteMetadataLanguageTo,
  normalizeDlsiteMetadataLanguages,
} from "@/features/maintenance/metadataLanguageModel";

describe("DLsite metadata language priority", () => {
  it("normalizes supported languages, removes duplicates, and keeps a default", () => {
    expect(normalizeDlsiteMetadataLanguages(["en-us", "en-us", "unknown"])).toEqual([
      "en-us",
      "ja-jp",
      "zh-cn",
      "zh-tw",
      "ko-kr",
    ]);
    expect(normalizeDlsiteMetadataLanguages([])).toEqual(["ja-jp", "en-us", "zh-cn", "zh-tw", "ko-kr"]);
  });

  it("moves a language earlier or later without mutating the input", () => {
    const languages = ["ja-jp", "en-us", "zh-cn"] as const;
    expect(moveDlsiteMetadataLanguage(languages, 1, -1)).toEqual(["en-us", "ja-jp", "zh-cn"]);
    expect(moveDlsiteMetadataLanguageTo(languages, 0, 2)).toEqual(["en-us", "zh-cn", "ja-jp"]);
    expect(languages).toEqual(["ja-jp", "en-us", "zh-cn"]);
  });
});

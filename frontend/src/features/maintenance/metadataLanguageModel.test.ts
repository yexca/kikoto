import { describe, expect, it } from "vitest";

import {
  dlsiteMetadataLanguagesFor,
  normalizeDlsiteMetadataLanguages,
  preferredDlsiteMetadataLanguage,
} from "@/features/maintenance/metadataLanguageModel";

describe("DLsite metadata display language", () => {
  it("normalizes selected languages, removes duplicates, and defaults to origin", () => {
    expect(normalizeDlsiteMetadataLanguages(["en-us", "en-us", "unknown"])).toEqual(["en-us", "origin"]);
    expect(normalizeDlsiteMetadataLanguages([])).toEqual(["origin"]);
    expect(normalizeDlsiteMetadataLanguages(["origin", "zh-cn"])).toEqual(["zh-cn", "origin"]);
  });

  it("shows the first stored language and falls back to origin", () => {
    expect(preferredDlsiteMetadataLanguage(["zh-cn", "en-us", "origin"])).toBe("zh-cn");
    expect(preferredDlsiteMetadataLanguage(["origin"])).toBe("origin");
    expect(preferredDlsiteMetadataLanguage(undefined)).toBe("origin");
  });

  it("stores a preferred language with origin as the final fallback", () => {
    expect(dlsiteMetadataLanguagesFor("ja-jp")).toEqual(["ja-jp", "origin"]);
    expect(dlsiteMetadataLanguagesFor("origin")).toEqual(["origin"]);
  });
});

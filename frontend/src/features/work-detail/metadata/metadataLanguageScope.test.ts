import { describe, expect, it } from "vitest";
import {
  metadataLanguageScopeForVariant,
  metadataLanguageScopeLabel,
  metadataLanguageScopes,
  scopeMatchesLanguage,
} from "./metadataLanguageScope";

const variant = (key: string, language: string, origin = false) => ({
  key,
  language,
  title: `Example ${key}`,
  tags: [],
  origin,
});
const label = (key: string) => key;

describe("metadata editor language scopes", () => {
  it("offers every language, each supported language whatever editions the work has, and the fallback", () => {
    const scopes = metadataLanguageScopes({
      metadataPresentation: { defaultVariantKey: "origin", variants: [variant("origin", "", true)] },
    });
    expect(scopes.primary.map((scope) => scope.key)).toEqual([
      "all",
      "language:ja-jp",
      "language:zh-cn",
      "language:zh-tw",
      "language:en-us",
      "language:ko-kr",
      "fallback",
    ]);
    expect(scopes.primary.every((scope) => scope.variant === null)).toBe(true);
  });

  it("keeps editions in other languages for the More menu, original first", () => {
    const scopes = metadataLanguageScopes(
      {
        metadataPresentation: {
          defaultVariantKey: "en",
          variants: [variant("de", "ger"), variant("en", "en-us"), variant("origin", "", true), variant("es", "spa")],
        },
      },
      "en",
    );
    expect(scopes.more.map((scope) => [scope.key, scope.language, scope.origin])).toEqual([
      ["edition:origin", "", true],
      ["language:ger", "ger", false],
      ["language:spa", "spa", false],
    ]);
    expect(scopes.more.map((scope) => metadataLanguageScopeLabel(scope, label, "en"))).toEqual([
      "libraryDetail.original",
      "German",
      "Spanish",
    ]);
    expect(metadataLanguageScopeLabel(scopes.more[1], label, "zh-Hans")).toBe("德语");
    expect(metadataLanguageScopeForVariant(scopes, "en")?.key).toBe("language:en-us");
    expect(metadataLanguageScopeForVariant(scopes, "es")?.key).toBe("language:spa");
  });

  it("matches an edition's raw provider language against a scope", () => {
    const scopes = metadataLanguageScopes({
      metadataPresentation: {
        defaultVariantKey: "origin",
        variants: [variant("origin", "", true), variant("zh", "zh-cn"), variant("de", "ger")],
      },
    });
    const [original, german] = scopes.more;
    const simplifiedChinese = scopes.primary.find((scope) => scope.language === "zh-cn")!;
    expect(scopeMatchesLanguage(simplifiedChinese, "CHI_HANS")).toBe(true);
    expect(scopeMatchesLanguage(simplifiedChinese, "CHI_HANT")).toBe(false);
    expect(scopeMatchesLanguage(german, "GER")).toBe(true);
    // An undeclared original stands for the original edition, never for a language.
    expect(scopeMatchesLanguage(original, "JPN", true)).toBe(true);
    expect(scopeMatchesLanguage(original, "", false)).toBe(false);
    expect(scopeMatchesLanguage(scopes.primary[0], "THA")).toBe(true);
    // The fallback stands for a work's own fallback title and tag names, never for an edition.
    const fallback = scopes.primary.find((scope) => scope.kind === "fallback")!;
    expect(scopeMatchesLanguage(fallback, "", false)).toBe(false);
    expect(scopeMatchesLanguage(fallback, "JPN", true)).toBe(false);
  });
});

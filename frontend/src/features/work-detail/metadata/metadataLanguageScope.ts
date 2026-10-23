import type { WorkDetail, WorkMetadataVariant } from "@/lib/api";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { metadataLanguageChoices, metadataVariantLabel } from "../metadataPresentationModel";

export type MetadataLanguageScope = {
  key: string;
  /**
   * `supported` is a language titles and tag names can be saved in.
   * `fallback` is the title and tag name shown in a language without its own.
   * `other` is an edition of this work in any other language, or with none declared.
   */
  kind: "all" | "supported" | "fallback" | "other";
  /** Normalized language; empty for every language and for an undeclared one. */
  language: string;
  /** The scope's edition is the original one. It never implies a language. */
  origin: boolean;
  /** The edition this work has in the scope's language, when it has one. */
  variant: WorkMetadataVariant | null;
};

export type MetadataLanguageScopes = {
  /** Every language, each supported language whether or not this work has it, then the fallback. */
  primary: MetadataLanguageScope[];
  /** The work's editions outside the supported languages, original first. */
  more: MetadataLanguageScope[];
};

export const allMetadataLanguagesScope: MetadataLanguageScope = {
  key: "all",
  kind: "all",
  language: "",
  origin: false,
  variant: null,
};

export const fallbackMetadataScope: MetadataLanguageScope = {
  key: "fallback",
  kind: "fallback",
  language: "",
  origin: false,
  variant: null,
};

const supportedLanguages: readonly string[] = metadataTagNameLanguages.map(([language]) => language);

const languageAliases: Record<string, string> = {
  ja: "ja-jp",
  jp: "ja-jp",
  jpn: "ja-jp",
  en: "en-us",
  eng: "en-us",
  zh: "zh-cn",
  cn: "zh-cn",
  "chi-hans": "zh-cn",
  "chi-simp": "zh-cn",
  "chi-hans-cn": "zh-cn",
  tw: "zh-tw",
  "chi-hant": "zh-tw",
  "chi-trad": "zh-tw",
  "chi-hant-tw": "zh-tw",
  ko: "ko-kr",
  kor: "ko-kr",
};

/**
 * Maps a provider's spelling of a supported language onto its settings token,
 * as the server does for metadata variants. Any other declared language keeps
 * its own lower-case spelling, so an edition's raw language and its variant's
 * language compare equal.
 */
export function normalizeMetadataLanguage(value: string) {
  const language = value.trim().toLowerCase().replace(/_/g, "-");
  return languageAliases[language] ?? language;
}

/**
 * Builds the editor's language scopes: a fixed tab per supported language, and
 * the editions this work actually has in other languages for the More menu.
 */
export function metadataLanguageScopes(
  work: Pick<WorkDetail, "metadataPresentation">,
  selectedKey = "",
): MetadataLanguageScopes {
  const choices = metadataLanguageChoices(work.metadataPresentation, selectedKey).map((choice) => ({
    ...choice,
    language: normalizeMetadataLanguage(choice.variant.language),
  }));
  const primary = supportedLanguages.map((language): MetadataLanguageScope => {
    const variant = choices.find((choice) => choice.language === language)?.variant ?? null;
    return { key: `language:${language}`, kind: "supported", language, origin: variant?.origin ?? false, variant };
  });
  const more = choices
    .filter((choice) => !supportedLanguages.includes(choice.language))
    .map((choice): MetadataLanguageScope => ({
      key: choice.key,
      kind: "other",
      language: choice.language,
      origin: choice.variant.origin,
      variant: choice.variant,
    }));
  return { primary: [allMetadataLanguagesScope, ...primary, fallbackMetadataScope], more };
}

export function findMetadataLanguageScope(scopes: MetadataLanguageScopes, key: string) {
  return [...scopes.primary, ...scopes.more].find((scope) => scope.key === key);
}

/** The scope showing a metadata variant, such as the one the detail page selected. */
export function metadataLanguageScopeForVariant(scopes: MetadataLanguageScopes, variantKey: string) {
  return [...scopes.primary, ...scopes.more].find((scope) => scope.variant?.key === variantKey);
}

const displayLanguageTags: Record<string, string> = {
  spa: "es",
  ger: "de",
  fre: "fr",
  ind: "id",
  ita: "it",
  por: "pt",
  swe: "sv",
  tha: "th",
  vie: "vi",
};

/**
 * Names a language outside the supported five in the interface language. A
 * spelling the browser cannot name is shown as the provider declared it.
 */
function otherLanguageName(language: string, locale: string) {
  try {
    const tag = displayLanguageTags[language] ?? language;
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) || language;
  } catch {
    return language;
  }
}

export function metadataLanguageScopeLabel(
  scope: MetadataLanguageScope,
  t: (key: string) => string,
  locale: string,
): string {
  if (scope.kind === "all") return t("metadataEditor.allLanguages");
  if (scope.kind === "fallback") return t("metadataEditor.fallback");
  const supported = metadataTagNameLanguages.find(([language]) => language === scope.language);
  if (supported) return t(supported[1]);
  if (!scope.variant) return otherLanguageName(scope.language, locale);
  return metadataVariantLabel(scope.variant, {
    original: t("libraryDetail.original"),
    language: (value) =>
      value.trim() ? otherLanguageName(normalizeMetadataLanguage(value), locale) : t("libraryDetail.unknownLanguage"),
  });
}

/**
 * Whether an edition or title language belongs to a scope. An original edition
 * without a declared language matches only its own scope, and the fallback
 * matches no language.
 */
export function scopeMatchesLanguage(scope: MetadataLanguageScope, language: string, origin = false) {
  if (scope.kind === "all") return true;
  if (scope.kind === "fallback") return false;
  const normalized = normalizeMetadataLanguage(language);
  if (!scope.language) return scope.origin ? origin : !origin && normalized === "";
  return scope.language === normalized;
}

export const dlsiteMetadataLanguageOptions = [
  { value: "origin", labelKey: "metadata.origin" },
  { value: "ja-jp", labelKey: "metadata.japanese" },
  { value: "en-us", labelKey: "metadata.english" },
  { value: "zh-cn", labelKey: "metadata.simplifiedChinese" },
  { value: "zh-tw", labelKey: "metadata.traditionalChinese" },
  { value: "ko-kr", labelKey: "metadata.korean" },
] as const;

export type DlsiteMetadataLanguage = (typeof dlsiteMetadataLanguageOptions)[number]["value"];

const supportedLanguages = new Set<string>(dlsiteMetadataLanguageOptions.map((option) => option.value));
const originLanguage = "origin" as DlsiteMetadataLanguage;

export function normalizeDlsiteMetadataLanguages(
  values: readonly string[] | null | undefined,
): DlsiteMetadataLanguage[] {
  const result: DlsiteMetadataLanguage[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (!supportedLanguages.has(value) || seen.has(value)) continue;
    if (value === originLanguage) {
      seen.add(value);
      continue;
    }
    seen.add(value);
    result.push(value as DlsiteMetadataLanguage);
  }
  result.push(originLanguage);
  return result;
}

/** The language shown first; origin when no edition language is preferred. */
export function preferredDlsiteMetadataLanguage(values: readonly string[] | null | undefined): DlsiteMetadataLanguage {
  return normalizeDlsiteMetadataLanguages(values)[0];
}

/** The stored priority for one preferred language, with origin as the final fallback. */
export function dlsiteMetadataLanguagesFor(language: DlsiteMetadataLanguage): DlsiteMetadataLanguage[] {
  return normalizeDlsiteMetadataLanguages([language]);
}

export const dlsiteMetadataLanguageOptions = [
  { value: "ja-jp", label: "Japanese" },
  { value: "en-us", label: "English" },
  { value: "zh-cn", label: "Simplified Chinese" },
  { value: "zh-tw", label: "Traditional Chinese" },
  { value: "ko-kr", label: "Korean" },
  { value: "origin", label: "Origin" },
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

export function moveDlsiteMetadataLanguage(
  values: readonly DlsiteMetadataLanguage[],
  index: number,
  direction: -1 | 1,
): DlsiteMetadataLanguage[] {
  return moveDlsiteMetadataLanguageTo(values, index, index + direction);
}

export function moveDlsiteMetadataLanguageTo(
  values: readonly DlsiteMetadataLanguage[],
  index: number,
  nextIndex: number,
): DlsiteMetadataLanguage[] {
  if (index < 0 || index >= values.length || nextIndex < 0 || nextIndex >= values.length) {
    return [...values];
  }
  if (values[index] === originLanguage || values[nextIndex] === originLanguage) {
    return [...values];
  }
  const next = [...values];
  const [value] = next.splice(index, 1);
  next.splice(nextIndex, 0, value);
  return next;
}

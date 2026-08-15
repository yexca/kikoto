import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { resources } from "@/i18n/resources";
import { currentScopedStorageKey } from "@/lib/clientStorageScope";

export type UiLocale = "auto" | "en" | "zh-Hans" | "zh-Hant" | "ja" | "ko";
export type ResolvedUiLocale = Exclude<UiLocale, "auto">;

export const UI_LOCALE_OPTIONS: readonly { value: UiLocale; labelKey: string }[] = [
  { value: "auto", labelKey: "languageOptions.auto" },
  { value: "en", labelKey: "languageOptions.en" },
  { value: "zh-Hans", labelKey: "languageOptions.zhHans" },
  { value: "zh-Hant", labelKey: "languageOptions.zhHant" },
  { value: "ja", labelKey: "languageOptions.ja" },
  { value: "ko", labelKey: "languageOptions.ko" },
];

export const DEFAULT_UI_LOCALE: UiLocale = "auto";
const ANONYMOUS_LOCALE_KEY = "kikoto:ui-locale";

void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "zh-Hans", "zh-Hant", "ja", "ko"],
  defaultNS: "translation",
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
  initImmediate: false,
  showSupportNotice: false,
});

export default i18n;

export function isUiLocale(value: unknown): value is UiLocale {
  return (
    value === "auto" || value === "en" || value === "zh-Hans" || value === "zh-Hant" || value === "ja" || value === "ko"
  );
}

export function normalizeUiLocale(value: unknown): UiLocale {
  return isUiLocale(value) ? value : DEFAULT_UI_LOCALE;
}

export function preferredSystemLanguages(): string[] {
  if (typeof navigator === "undefined") return ["en"];
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [];
  return [...languages, navigator.language].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
}

export function resolveUiLocale(preference: UiLocale, languages = preferredSystemLanguages()): ResolvedUiLocale {
  if (preference !== "auto") return preference;
  for (const language of languages) {
    const normalized = language.toLowerCase().replace(/_/g, "-");
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (
      normalized.includes("hant") ||
      ["zh-tw", "zh-hk", "zh-mo"].some((tag) => normalized === tag || normalized.startsWith(`${tag}-`))
    ) {
      return "zh-Hant";
    }
    if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-Hans";
    if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
    if (normalized === "ko" || normalized.startsWith("ko-")) return "ko";
  }
  return "en";
}

export function intlLocaleFor(locale: ResolvedUiLocale): string {
  switch (locale) {
    case "zh-Hans":
      return "zh-CN";
    case "zh-Hant":
      return "zh-TW";
    case "ja":
      return "ja-JP";
    case "ko":
      return "ko-KR";
    default:
      return "en-US";
  }
}

export function anonymousLocaleStorageKey() {
  if (typeof window === "undefined") return ANONYMOUS_LOCALE_KEY;
  return currentScopedStorageKey(ANONYMOUS_LOCALE_KEY, null);
}

export function readAnonymousUiLocale(): UiLocale {
  if (typeof localStorage === "undefined") return DEFAULT_UI_LOCALE;
  return normalizeUiLocale(localStorage.getItem(anonymousLocaleStorageKey()));
}

export function writeAnonymousUiLocale(value: UiLocale) {
  if (typeof localStorage !== "undefined") localStorage.setItem(anonymousLocaleStorageKey(), value);
}

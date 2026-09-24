import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import i18n, {
  DEFAULT_UI_LOCALE,
  ensureUiLocale,
  intlLocaleFor,
  isUiLocale,
  normalizeUiLocale,
  resolveUiLocale,
  UI_LOCALE_OPTIONS,
} from "@/i18n";
import { resources } from "@/i18n/resources/all";

describe("UI locale resolution", () => {
  it("accepts only supported stored preferences", () => {
    for (const option of UI_LOCALE_OPTIONS) expect(isUiLocale(option.value)).toBe(true);
    expect(isUiLocale("fr")).toBe(false);
    expect(normalizeUiLocale("fr")).toBe(DEFAULT_UI_LOCALE);
    expect(normalizeUiLocale(null)).toBe(DEFAULT_UI_LOCALE);
  });

  it.each([
    [["zh-CN"], "zh-Hans"],
    [["zh-SG"], "zh-Hans"],
    [["zh-MY"], "zh-Hans"],
    [["zh-TW"], "zh-Hant"],
    [["zh-Hant-HK"], "zh-Hant"],
    [["ja-JP"], "ja"],
    [["ko-KR"], "ko"],
    [["fr-FR", "en-GB"], "en"],
    [["fr-FR"], "en"],
  ] as const)("maps browser languages %j to %s", (languages, expected) => {
    expect(resolveUiLocale("auto", [...languages])).toBe(expected);
  });

  it("keeps an explicit preference independent of browser languages", () => {
    expect(resolveUiLocale("ko", ["zh-CN"])).toBe("ko");
    expect(intlLocaleFor("zh-Hant")).toBe("zh-TW");
  });
});

describe("translation resources", () => {
  it("loads deferred locale resources on demand", async () => {
    await Promise.all([ensureUiLocale("zh-Hans"), ensureUiLocale("ja"), ensureUiLocale("ko")]);

    expect(i18n.getResource("zh-Hans", "translation", "app.name")).toBe("Kikoto");
    expect(i18n.getResource("ja", "translation", "app.name")).toBe("Kikoto");
    expect(i18n.getResource("ko", "translation", "app.name")).toBe("Kikoto");
  });

  it("keeps the language picker labels in each language's own script", () => {
    const expected = ["Auto", "English", "简体中文", "正體中文", "日本語", "한국어"];
    for (const resource of Object.values(resources)) {
      expect(Object.values(resource.translation.languageOptions)).toEqual(expected);
    }
  });

  it("keeps other languages' copy out of the English fallback modules", () => {
    // The English fallback ships in the initial bundle, so a module it imports
    // must not also define deferred locales. Only the picker's native labels remain.
    const nativeLabels = /简体中文|正體中文|日本語|한국어/gu;
    for (const module of ["./resources.ts", "./surfaces/en.ts", "./surfaces/adminTools.ts"]) {
      const source = readFileSync(new URL(module, import.meta.url), "utf8").replace(nativeLabels, "");
      expect(
        source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu),
        module,
      ).toBeNull();
    }
  });

  it("provides the same translation keys for every supported locale", () => {
    const keyPaths = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return child && typeof child === "object" ? keyPaths(child, path) : [path];
      });
    const englishKeys = keyPaths(resources.en.translation).sort();
    for (const resource of Object.values(resources)) {
      expect(keyPaths(resource.translation).sort()).toEqual(englishKeys);
    }
  });

  it("keeps interpolation variables aligned across locales", () => {
    const values = (value: unknown, prefix = ""): Record<string, string[]> => {
      if (!value || typeof value !== "object") return {};
      return Object.entries(value).reduce<Record<string, string[]>>((result, [key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof child === "string") {
          result[path] = [...child.matchAll(/\{\{\s*([\w-]+)/g)].map((match) => match[1]).sort();
        } else Object.assign(result, values(child, path));
        return result;
      }, {});
    };
    const englishValues = values(resources.en.translation);
    for (const resource of Object.values(resources)) expect(values(resource.translation)).toEqual(englishValues);
  });

  it("translates sections that inherit the English copy through object spreads", () => {
    // These locale sections start from `...english` so a missing translation
    // still passes key parity while silently rendering English. Values that are
    // intentionally identical in every locale must be listed here.
    const inheritedSections = ["library", "collection", "workCard", "maintenance", "workflowPage"] as const;
    const intentionallyEnglish = new Set([
      // Interpolation-only format.
      "collection.filterValue",
      "maintenance.library.apiUrl",
      // Synthetic identifier examples.
      "workflowPage.presetTargetPlaceholders.circleId",
      "workflowPage.presetTargetPlaceholders.seriesId",
      "workflowPage.metadataSyncScope.circlePlaceholder",
    ]);
    const strings = (value: unknown, prefix: string): [string, string][] =>
      Object.entries(value as object).flatMap(([key, child]) => {
        const path = `${prefix}.${key}`;
        return typeof child === "string" ? [[path, child] as [string, string]] : strings(child, path);
      });
    const english = resources.en.translation as Record<string, unknown>;
    for (const [locale, resource] of Object.entries(resources)) {
      if (locale === "en") continue;
      const translation = resource.translation as Record<string, unknown>;
      const untranslated = inheritedSections.flatMap((section) => {
        const localized = new Map(strings(translation[section], section));
        return strings(english[section], section)
          .filter(([path, value]) => localized.get(path) === value && !intentionallyEnglish.has(path))
          .map(([path]) => path);
      });
      expect(untranslated, locale).toEqual([]);
    }
  });
});

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
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import i18n, { ensureUiLocale } from "@/i18n";
import { languageLabel, languageShortLabel } from "./workDetailHelpers";

describe("work detail language labels", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("abbreviates each provider spelling of a language to one code", () => {
    expect(["ja", "ja-JP", "jpn"].map(languageShortLabel)).toEqual(["JA", "JA", "JA"]);
    expect(["zh", "zh-cn", "CHI_HANS"].map(languageShortLabel)).toEqual(["SC", "SC", "SC"]);
    expect(["zh-tw", "chi_hant"].map(languageShortLabel)).toEqual(["TC", "TC"]);
    expect(["en-us", "ko_kr", "spa"].map(languageShortLabel)).toEqual(["EN", "KO", "ES"]);
  });

  it("upper-cases an unlisted language tag and keeps any other spelling whole", () => {
    expect(languageShortLabel("ru-ru")).toBe("RU-RU");
    expect(languageShortLabel("Fan translation")).toBe("Fan translation");
    expect(languageShortLabel("")).toBe("Unknown language");
  });

  it("names languages in the interface language", async () => {
    expect(languageLabel("ja-jp")).toBe("Japanese");
    expect(languageLabel("spa")).toBe("Spanish");

    await ensureUiLocale("zh-Hans");
    await i18n.changeLanguage("zh-Hans");
    expect(languageLabel("ja-jp")).toBe(i18n.t("metadata.japanese"));
    expect(languageLabel("ja-jp")).not.toBe("Japanese");
    expect(languageLabel("spa")).toBe(new Intl.DisplayNames(["zh-Hans"], { type: "language" }).of("es"));
    expect(languageShortLabel("ja-jp")).toBe("JA");
  });
});

import { describe, expect, it } from "vitest";
import {
  changedTitles,
  currentTitles,
  titleFieldStatus,
  titleLanguageMarkers,
  titleSourceLabel,
} from "./titleEditorModel";

describe("title language markers", () => {
  const work = {
    metadataPresentation: {
      defaultVariantKey: "chinese",
      variants: [
        { key: "original", language: "ja-jp", title: "Example original", tags: [], origin: true },
        { key: "chinese", language: "zh-cn", title: "Example Chinese", tags: [], origin: false },
      ],
    },
  };

  it("marks the original language and the default displayed language separately", () => {
    expect(titleLanguageMarkers(work, "")).toEqual({ origin: "ja-jp", current: "zh-cn" });
  });

  it("follows an explicit selection, including both markers on the original language", () => {
    expect(titleLanguageMarkers(work, "original")).toEqual({ origin: "ja-jp", current: "ja-jp" });
  });

  it("does not infer an undeclared original language from the displayed translation", () => {
    const unknownOriginal = {
      ...work,
      metadataPresentation: {
        ...work.metadataPresentation,
        variants: work.metadataPresentation.variants.map((variant) =>
          variant.origin ? { ...variant, language: "" } : variant,
        ),
      },
    };
    expect(titleLanguageMarkers(unknownOriginal, "")).toEqual({ origin: "", current: "zh-cn" });
    expect(titleLanguageMarkers(unknownOriginal, "original")).toEqual({ origin: "", current: "" });
  });
});

describe("language title drafts", () => {
  const manual = { title: "Global", titles: { "": "Global", "ja-jp": "Japanese" } };
  it("leaves placeholders and untouched languages out of PATCH", () => {
    expect(changedTitles({}, manual)).toEqual({});
    expect(changedTitles({ "en-us": "" }, manual)).toEqual({});
    expect(changedTitles({ "ja-jp": " Japanese ", "zh-cn": " Example Chinese " }, manual)).toEqual({
      "zh-cn": "Example Chinese",
    });
  });
  it("treats a kept or cleared prefilled inherited title as unchanged", () => {
    const current = { "": "Global", "ja-jp": "Japanese", "zh-cn": "Example Chinese" };
    expect(changedTitles({ "zh-cn": " Example Chinese ", "en-us": "" }, manual, current)).toEqual({});
    expect(changedTitles({ "zh-cn": "Example Chinese revised" }, manual, current)).toEqual({
      "zh-cn": "Example Chinese revised",
    });
    expect(titleFieldStatus("Example Chinese", undefined, "Example Chinese")).toBe("source");
    expect(titleFieldStatus("", undefined, "Example Chinese")).toBe("source");
    expect(titleFieldStatus("", "Japanese", "Japanese")).toBe("reverting");
  });
  it("clears only the edited language and preserves authored prefixes", () => {
    expect(changedTitles({ "ja-jp": "", "zh-cn": "【简体中文版】Authored" }, manual)).toEqual({
      "ja-jp": null,
      "zh-cn": "【简体中文版】Authored",
    });
  });
});

describe("current titles", () => {
  it("prefills own, inherited universal, provider, and fallback titles", () => {
    const titles = currentTitles({
      title: "Example fallback",
      manualOverrides: { title: "Global", titles: { "": "Global", "ja-jp": "Japanese" } },
      titleChoices: {
        "zh-cn": { title: "Example Chinese", language: "zh-cn", source: "dlsite", code: "RJ00000001", description: "" },
      },
    });
    expect(titles).toMatchObject({ "": "Global", "ja-jp": "Japanese", "zh-cn": "Example Chinese", "en-us": "Global" });
    expect(currentTitles({ title: "Example fallback", manualOverrides: {} })["ko-kr"]).toBe("Example fallback");
  });
});

describe("title source label", () => {
  const remote = {
    title: "Example Work",
    language: "",
    source: "remote" as const,
    sourceName: "Example Remote A",
    code: "RJ00000000",
    description: "",
  };
  it("names the remote source that filled a title", () => {
    expect(titleSourceLabel("zh-cn", {}, remote)).toEqual({
      key: "workTitles.remote",
      values: { source: "Example Remote A" },
    });
  });
  it("keeps manual precedence over a remote title", () => {
    expect(titleSourceLabel("zh-cn", { "": "Global" }, remote)).toEqual({ key: "workTitles.manualAll" });
    expect(titleSourceLabel("zh-cn", { "zh-cn": "Chinese" }, remote)).toEqual({ key: "workTitles.manual" });
  });
});

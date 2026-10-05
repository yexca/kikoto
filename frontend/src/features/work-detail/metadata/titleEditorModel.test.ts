import { describe, expect, it } from "vitest";
import { changedTitles, titleSourceLabel } from "./titleEditorModel";

describe("language title drafts", () => {
  const manual = { title: "Global", titles: { "": "Global", "ja-jp": "Japanese" } };
  it("leaves placeholders and untouched languages out of PATCH", () => {
    expect(changedTitles({}, manual)).toEqual({});
    expect(changedTitles({ "en-us": "" }, manual)).toEqual({});
    expect(changedTitles({ "ja-jp": " Japanese ", "zh-cn": " Example Chinese " }, manual)).toEqual({
      "zh-cn": "Example Chinese",
    });
  });
  it("clears only the edited language and preserves authored prefixes", () => {
    expect(changedTitles({ "ja-jp": "", "zh-cn": "【简体中文版】Authored" }, manual)).toEqual({
      "ja-jp": null,
      "zh-cn": "【简体中文版】Authored",
    });
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

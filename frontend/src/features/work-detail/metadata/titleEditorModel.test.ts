import { describe, expect, it } from "vitest";
import { changedTitles } from "./titleEditorModel";

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

import { describe, expect, it } from "vitest";

import { translationCenterViewFromSearch, visibleTranslationCenterViews } from "./translationCenterModel";

describe("Translation page views", () => {
  it("opens the view a link names", () => {
    expect(translationCenterViewFromSearch("")).toBeNull();
    expect(translationCenterViewFromSearch("?view=coverage")).toBe("coverage");
    expect(translationCenterViewFromSearch("?view=unknown")).toBeNull();
  });

  it("shows the review inbox only while items wait for review", () => {
    expect(visibleTranslationCenterViews(true, 0)).toEqual(["running", "attention", "history", "coverage"]);
    expect(visibleTranslationCenterViews(true, 2)[0]).toBe("review");
    expect(visibleTranslationCenterViews(false, 0)[0]).toBe("review");
  });
});

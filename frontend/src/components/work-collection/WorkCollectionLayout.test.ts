import { describe, expect, it } from "vitest";

import { workCollectionClassName, workCollectionStyle } from "./workCollectionLayoutModel";

describe("work collection layout", () => {
  it("uses one grid layout", () => {
    expect(workCollectionClassName()).toContain("grid");
    expect(workCollectionClassName()).not.toContain("column-count");
  });

  it("uses container-driven tracks for the automatic grid layout", () => {
    const style = workCollectionStyle("auto", "auto") as Record<string, string>;

    expect(style["--mobile-grid-template"]).toContain("repeat(auto-fill");
    expect(style["--desktop-grid-template"]).toContain("max(16rem, calc(20% - 0.8rem))");
  });

  it("preserves explicit column overrides", () => {
    const style = workCollectionStyle(2, 7) as Record<string, string>;

    expect(style["--mobile-grid-template"]).toBe("repeat(2, minmax(0, 1fr))");
    expect(style["--desktop-grid-template"]).toBe("repeat(7, minmax(0, 1fr))");
  });
});

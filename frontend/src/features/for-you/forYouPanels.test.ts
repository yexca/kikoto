import { describe, expect, it } from "vitest";

import { forYouPanelFromSearch } from "./forYouPanels";

describe("forYouPanelFromSearch", () => {
  it("opens the named settings tab, Tuning for an unknown one, and none without a panel", () => {
    expect(forYouPanelFromSearch("?panel=activity")).toBe("activity");
    expect(forYouPanelFromSearch("?panel=tuning")).toBe("tuning");
    expect(forYouPanelFromSearch("?panel=other")).toBe("tuning");
    expect(forYouPanelFromSearch("")).toBeNull();
  });
});

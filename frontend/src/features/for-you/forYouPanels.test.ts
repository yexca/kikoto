import { describe, expect, it } from "vitest";

import { forYouPanelFromSearch } from "./forYouPanels";

describe("forYouPanelFromSearch", () => {
  it("opens the settings at the named place, the tuning for an unknown one, and not without a panel", () => {
    expect(forYouPanelFromSearch("?panel=activity")).toBe("activity");
    expect(forYouPanelFromSearch("?panel=tuning")).toBe("tuning");
    expect(forYouPanelFromSearch("?panel=other")).toBe("tuning");
    expect(forYouPanelFromSearch("")).toBeNull();
  });
});

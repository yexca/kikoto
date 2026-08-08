import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_THEME_ACCENT, getStoredThemeAccent, THEME_ACCENT_OPTIONS } from "@/app/theme";

describe("theme accent preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses cobalt blue when no valid accent is stored", () => {
    for (const storedValue of [null, "purple"]) {
      vi.stubGlobal("localStorage", { getItem: () => storedValue });
      expect(getStoredThemeAccent()).toBe("blue");
    }
    expect(DEFAULT_THEME_ACCENT).toBe("blue");
  });

  it.each(["pink", "blue", "green"] as const)("preserves a stored %s accent", (storedValue) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemeAccent()).toBe(storedValue);
  });

  it("lists the default accent first in the shared picker options", () => {
    expect(THEME_ACCENT_OPTIONS.map((option) => option.value)).toEqual(["blue", "pink", "green"]);
  });
});

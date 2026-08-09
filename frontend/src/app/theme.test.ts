import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_THEME_PRESET, getStoredThemePreset, themeColorFor, THEME_PRESET_OPTIONS } from "@/app/theme";

describe("theme preset preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Claude when no valid preset is stored", () => {
    for (const storedValue of [null, "blue", "purple"]) {
      vi.stubGlobal("localStorage", { getItem: () => storedValue });
      expect(getStoredThemePreset()).toBe("claude");
    }
    expect(DEFAULT_THEME_PRESET).toBe("claude");
  });

  it.each(["claude", "openai", "apple", "google-md"] as const)("preserves a stored %s preset", (storedValue) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemePreset()).toBe(storedValue);
  });

  it("lists the default preset first", () => {
    expect(THEME_PRESET_OPTIONS.map((option) => option.value)).toEqual(["claude", "openai", "apple", "google-md"]);
  });

  it("provides light and dark browser chrome colors for every preset", () => {
    for (const option of THEME_PRESET_OPTIONS) {
      expect(themeColorFor(option.value, "light")).toMatch(/^#[0-9a-f]{6}$/i);
      expect(themeColorFor(option.value, "dark")).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

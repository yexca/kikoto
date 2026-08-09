import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME_PALETTE,
  DEFAULT_THEME_PRESET,
  getStoredThemePalette,
  getStoredThemePreset,
  themeColorFor,
  THEME_PALETTE_OPTIONS,
  THEME_PRESET_OPTIONS,
} from "@/app/theme";

describe("theme preset preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Anthropic when no valid preset is stored", () => {
    for (const storedValue of [null, "blue", "purple"]) {
      vi.stubGlobal("localStorage", { getItem: () => storedValue });
      expect(getStoredThemePreset()).toBe("anthropic");
    }
    expect(DEFAULT_THEME_PRESET).toBe("anthropic");
  });

  it.each(["anthropic", "openai", "apple", "google-md"] as const)("preserves a stored %s preset", (storedValue) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemePreset()).toBe(storedValue);
  });

  it("migrates the former Claude preset value to Anthropic", () => {
    vi.stubGlobal("localStorage", { getItem: () => "claude" });
    expect(getStoredThemePreset()).toBe("anthropic");
  });

  it("lists the default preset first", () => {
    expect(THEME_PRESET_OPTIONS.map((option) => option.value)).toEqual(["anthropic", "openai", "apple", "google-md"]);
  });

  it("provides light and dark browser chrome colors for every preset", () => {
    for (const option of THEME_PRESET_OPTIONS) {
      expect(themeColorFor(option.value, "light")).toMatch(/^#[0-9a-f]{6}$/i);
      expect(themeColorFor(option.value, "dark")).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("theme palette preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Original when no valid palette is stored", () => {
    for (const storedValue of [null, "blue", "rose"]) {
      vi.stubGlobal("localStorage", { getItem: () => storedValue });
      expect(getStoredThemePalette()).toBe("original");
    }
    expect(DEFAULT_THEME_PALETTE).toBe("original");
  });

  it.each(["original", "graphite", "cobalt", "iris"] as const)("preserves a stored %s palette", (storedValue) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemePalette()).toBe(storedValue);
  });

  it("keeps the palette list small and places Original first", () => {
    expect(THEME_PALETTE_OPTIONS.map((option) => option.value)).toEqual(["original", "graphite", "cobalt", "iris"]);
  });
});

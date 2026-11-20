import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_THEME_PALETTE,
  DEFAULT_THEME_PRESET,
  getStoredThemePalette,
  getStoredThemePreset,
  resolveThemePalette,
  themeColorFor,
  themePaletteOptions,
  THEME_PRESET_OPTIONS,
} from "@/app/theme";

const stylesheet = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

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
    for (const storedValue of [null, "rose", "cyan"]) {
      vi.stubGlobal("localStorage", { getItem: () => storedValue });
      expect(getStoredThemePalette()).toBe("original");
    }
    expect(DEFAULT_THEME_PALETTE).toBe("original");
  });

  it.each(["original", "green", "purple", "orange"] as const)("preserves a stored %s palette", (storedValue) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemePalette()).toBe(storedValue);
  });

  it.each([
    ["graphite", "original"],
    ["cobalt", "blue"],
    ["iris", "purple"],
  ] as const)("maps the former %s palette to %s", (storedValue, palette) => {
    vi.stubGlobal("localStorage", { getItem: () => storedValue });
    expect(getStoredThemePalette()).toBe(palette);
  });

  it("offers Original first and at least one distinct alternate for every preset", () => {
    for (const option of THEME_PRESET_OPTIONS) {
      const palettes = themePaletteOptions(option.value).map((palette) => palette.value);
      expect(palettes[0]).toBe("original");
      expect(palettes.length).toBeGreaterThan(1);
      expect(new Set(palettes).size).toBe(palettes.length);
    }
  });

  it("shows Original for a hue the preset does not offer and keeps an offered one", () => {
    expect(resolveThemePalette("apple", "green")).toBe("original");
    expect(resolveThemePalette("google-md", "green")).toBe("green");
  });

  it("swatches show the accent the stylesheet applies in each mode", () => {
    for (const option of THEME_PRESET_OPTIONS) {
      for (const { value, accent } of themePaletteOptions(option.value).slice(1)) {
        const selector = `[data-theme-preset="${option.value}"][data-theme-palette="${value}"]`;
        expect(primaryFor(`:root${selector}`)).toBe(accent.light);
        expect(primaryFor(`.dark${selector}`)).toBe(accent.dark);
      }
    }
  });
});

function primaryFor(selector: string) {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  return /--primary:\s*([^;]+);/.exec(stylesheet.slice(start))?.[1];
}

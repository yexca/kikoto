import { deviceKey, localStore } from "@/lib/clientStorage";

export type ThemeMode = "light" | "dark" | "system";
export type ThemePreset = "anthropic" | "openai" | "apple" | "google-md";
/** An accent hue. Each preset offers Original plus the accents its design source publishes. */
export type ThemePalette = "original" | "green" | "blue" | "purple" | "pink" | "orange";

type ResolvedThemeMode = Exclude<ThemeMode, "system">;
/** HSL channels in the form styles.css uses for `--primary`. */
type ThemeAccent = Record<ResolvedThemeMode, string>;

export const DEFAULT_THEME_PRESET: ThemePreset = "anthropic";
export const DEFAULT_THEME_PALETTE: ThemePalette = "original";
/**
 * Each preset's accents in display order, taken from the design source the
 * preset follows (see the Visual Direction section of docs/development/design.md).
 * The `--primary` values in styles.css match these, so a swatch shows the color
 * the theme applies.
 */
export const THEME_PRESET_OPTIONS = [
  {
    value: "anthropic",
    label: "Anthropic",
    accents: {
      original: { light: "15 57% 43%", dark: "19 76% 70%" },
      blue: { light: "210 49% 42%", dark: "210 55% 70%" },
      green: { light: "86 22% 36%", dark: "86 25% 64%" },
    },
    themeColor: { light: "#f7f3ed", dark: "#1a1715" },
  },
  {
    value: "openai",
    label: "OpenAI",
    accents: {
      original: { light: "160 84% 28%", dark: "160 55% 60%" },
      blue: { light: "209 100% 50%", dark: "209 100% 50%" },
      purple: { light: "264 91% 64%", dark: "264 91% 64%" },
      orange: { light: "21 94% 46%", dark: "21 94% 46%" },
    },
    themeColor: { light: "#fafafa", dark: "#141414" },
  },
  {
    value: "apple",
    label: "Apple",
    accents: {
      original: { light: "208 100% 50%", dark: "206 100% 50%" },
      purple: { light: "293 74% 53%", dark: "293 88% 58%" },
      pink: { light: "349 100% 59%", dark: "348 100% 61%" },
      orange: { light: "28 100% 58%", dark: "28 100% 59%" },
    },
    themeColor: { light: "#f2f2f7", dark: "#111112" },
  },
  {
    value: "google-md",
    label: "Google MD",
    accents: {
      original: { light: "212 100% 38%", dark: "221 100% 84%" },
      green: { light: "143 100% 22%", dark: "129 60% 66%" },
      purple: { light: "273 73% 49%", dark: "273 100% 86%" },
      orange: { light: "28 100% 30%", dark: "23 100% 77%" },
    },
    themeColor: { light: "#f8fafd", dark: "#121316" },
  },
] as const satisfies ReadonlyArray<{
  value: ThemePreset;
  label: string;
  accents: { original: ThemeAccent } & Partial<Record<ThemePalette, ThemeAccent>>;
  themeColor: Record<ResolvedThemeMode, string>;
}>;
const THEME_PALETTE_LABELS: Record<ThemePalette, string> = {
  original: "Original",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  orange: "Orange",
};
const THEME_PALETTES = Object.keys(THEME_PALETTE_LABELS) as ThemePalette[];
/** Stored values from the former shared palettes and the hue that replaces each. */
const FORMER_THEME_PALETTES = new Map<string, ThemePalette>([
  ["graphite", "original"],
  ["cobalt", "blue"],
  ["iris", "purple"],
]);

const THEME_STORAGE_KEY = deviceKey("kikoto:theme");
const THEME_PRESET_STORAGE_KEY = deviceKey("kikoto:theme-preset");
const THEME_PALETTE_STORAGE_KEY = deviceKey("kikoto:theme-palette");
export const THEME_CHANGE_EVENT = "kikoto:theme-change";
export const THEME_PRESET_CHANGE_EVENT = "kikoto:theme-preset-change";
export const THEME_PALETTE_CHANGE_EVENT = "kikoto:theme-palette-change";
const darkModeQuery = "(prefers-color-scheme: dark)";

export function getStoredThemeMode(): ThemeMode {
  const value = localStore.read(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storeThemeMode(mode: ThemeMode) {
  localStore.write(THEME_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }));
}

export function getStoredThemePreset(): ThemePreset {
  const value = localStore.read(THEME_PRESET_STORAGE_KEY);
  if (value === "claude") return "anthropic";
  return isThemePreset(value) ? value : DEFAULT_THEME_PRESET;
}

export function storeThemePreset(preset: ThemePreset) {
  localStore.write(THEME_PRESET_STORAGE_KEY, preset);
  window.dispatchEvent(new CustomEvent<ThemePreset>(THEME_PRESET_CHANGE_EVENT, { detail: preset }));
}

export function getStoredThemePalette(): ThemePalette {
  const value = localStore.read(THEME_PALETTE_STORAGE_KEY);
  if (isThemePalette(value)) return value;
  return FORMER_THEME_PALETTES.get(value ?? "") ?? DEFAULT_THEME_PALETTE;
}

export function storeThemePalette(palette: ThemePalette) {
  localStore.write(THEME_PALETTE_STORAGE_KEY, palette);
  window.dispatchEvent(new CustomEvent<ThemePalette>(THEME_PALETTE_CHANGE_EVENT, { detail: palette }));
}

export function systemPrefersDark() {
  return window.matchMedia(darkModeQuery).matches;
}

export function resolvedThemeMode(mode: ThemeMode): ResolvedThemeMode {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

export function applyThemeMode(mode: ThemeMode) {
  const resolved = resolvedThemeMode(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  updateThemeColor(resolved, getStoredThemePreset());
}

export function applyThemePreset(preset: ThemePreset) {
  document.documentElement.dataset.themePreset = preset;
  delete document.documentElement.dataset.themeAccent;
  updateThemeColor(resolvedThemeMode(getStoredThemeMode()), preset);
}

export function applyThemePalette(palette: ThemePalette) {
  document.documentElement.dataset.themePalette = palette;
  delete document.documentElement.dataset.themeAccent;
}

export function initializeStoredTheme() {
  applyThemePreset(getStoredThemePreset());
  applyThemePalette(getStoredThemePalette());
  applyThemeMode(getStoredThemeMode());
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia(darkModeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function themeColorFor(preset: ThemePreset, mode: ResolvedThemeMode) {
  return THEME_PRESET_OPTIONS.find((option) => option.value === preset)?.themeColor[mode] ?? "#f7f3ed";
}

export function themePresetLabel(preset: ThemePreset) {
  return THEME_PRESET_OPTIONS.find((option) => option.value === preset)?.label ?? "Anthropic";
}

export function themePaletteLabel(palette: ThemePalette) {
  return THEME_PALETTE_LABELS[palette];
}

/** The palettes a preset offers, Original first, with each one's light and dark accent. */
export function themePaletteOptions(preset: ThemePreset): Array<{ value: ThemePalette; accent: ThemeAccent }> {
  const accents: Partial<Record<ThemePalette, ThemeAccent>> = presetOption(preset).accents;
  return (Object.keys(accents) as ThemePalette[]).map((value) => ({ value, accent: accents[value]! }));
}

/**
 * The palette a preset shows. A stored hue the preset does not offer falls back
 * to Original, so switching back to a preset that offers it restores it.
 */
export function resolveThemePalette(preset: ThemePreset, palette: ThemePalette): ThemePalette {
  return palette in presetOption(preset).accents ? palette : "original";
}

function presetOption(preset: ThemePreset) {
  return THEME_PRESET_OPTIONS.find((option) => option.value === preset) ?? THEME_PRESET_OPTIONS[0];
}

function isThemePreset(value: string | null): value is ThemePreset {
  return value === "anthropic" || value === "openai" || value === "apple" || value === "google-md";
}

function isThemePalette(value: string | null): value is ThemePalette {
  return (THEME_PALETTES as readonly (string | null)[]).includes(value);
}

function updateThemeColor(mode: ResolvedThemeMode, preset: ThemePreset) {
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", themeColorFor(preset, mode));
}

export type ThemeMode = "light" | "dark" | "system";
export type ThemePreset = "anthropic" | "openai" | "apple" | "google-md";
export type ThemePalette = "original" | "graphite" | "cobalt" | "iris";

type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export const DEFAULT_THEME_PRESET: ThemePreset = "anthropic";
export const DEFAULT_THEME_PALETTE: ThemePalette = "original";
export const THEME_PRESET_OPTIONS = [
  {
    value: "anthropic",
    label: "Anthropic",
    swatches: ["#ad4f2f", "#f7f3ed", "#302a26"],
    themeColor: { light: "#f7f3ed", dark: "#1a1715" },
  },
  {
    value: "openai",
    label: "OpenAI",
    swatches: ["#10a37f", "#fafafa", "#202020"],
    themeColor: { light: "#fafafa", dark: "#141414" },
  },
  {
    value: "apple",
    label: "Apple",
    swatches: ["#007aff", "#f2f2f7", "#1c1c1e"],
    themeColor: { light: "#f2f2f7", dark: "#111112" },
  },
  {
    value: "google-md",
    label: "Google MD",
    swatches: ["#1a73e8", "#f8fafd", "#202124"],
    themeColor: { light: "#f8fafd", dark: "#121316" },
  },
] as const satisfies ReadonlyArray<{
  value: ThemePreset;
  label: string;
  swatches: readonly [string, string, string];
  themeColor: Record<ResolvedThemeMode, string>;
}>;
export const THEME_PALETTE_OPTIONS = [
  { value: "original", label: "Original", swatch: null },
  { value: "graphite", label: "Graphite", swatch: "#4a4a50" },
  { value: "cobalt", label: "Cobalt", swatch: "#315fd6" },
  { value: "iris", label: "Iris", swatch: "#7552b5" },
] as const satisfies ReadonlyArray<{
  value: ThemePalette;
  label: string;
  swatch: string | null;
}>;

const THEME_STORAGE_KEY = "kikoto:theme";
const THEME_PRESET_STORAGE_KEY = "kikoto:theme-preset";
const THEME_PALETTE_STORAGE_KEY = "kikoto:theme-palette";
export const THEME_CHANGE_EVENT = "kikoto:theme-change";
export const THEME_PRESET_CHANGE_EVENT = "kikoto:theme-preset-change";
export const THEME_PALETTE_CHANGE_EVENT = "kikoto:theme-palette-change";
const darkModeQuery = "(prefers-color-scheme: dark)";

export function getStoredThemeMode(): ThemeMode {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storeThemeMode(mode: ThemeMode) {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }));
}

export function getStoredThemePreset(): ThemePreset {
  const value = localStorage.getItem(THEME_PRESET_STORAGE_KEY);
  if (value === "claude") return "anthropic";
  return isThemePreset(value) ? value : DEFAULT_THEME_PRESET;
}

export function storeThemePreset(preset: ThemePreset) {
  localStorage.setItem(THEME_PRESET_STORAGE_KEY, preset);
  window.dispatchEvent(new CustomEvent<ThemePreset>(THEME_PRESET_CHANGE_EVENT, { detail: preset }));
}

export function getStoredThemePalette(): ThemePalette {
  const value = localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
  return isThemePalette(value) ? value : DEFAULT_THEME_PALETTE;
}

export function storeThemePalette(palette: ThemePalette) {
  localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);
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
  return THEME_PALETTE_OPTIONS.find((option) => option.value === palette)?.label ?? "Original";
}

function isThemePreset(value: string | null): value is ThemePreset {
  return value === "anthropic" || value === "openai" || value === "apple" || value === "google-md";
}

function isThemePalette(value: string | null): value is ThemePalette {
  return value === "original" || value === "graphite" || value === "cobalt" || value === "iris";
}

function updateThemeColor(mode: ResolvedThemeMode, preset: ThemePreset) {
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", themeColorFor(preset, mode));
}

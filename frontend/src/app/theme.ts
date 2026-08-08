export type ThemeMode = "light" | "dark" | "system";
export type ThemeAccent = "pink" | "blue" | "green";

export const DEFAULT_THEME_ACCENT: ThemeAccent = "blue";
export const THEME_ACCENT_OPTIONS = [
  { value: "blue", label: "Blue", swatch: "#315fd6" },
  { value: "pink", label: "Pink", swatch: "#b5307c" },
  { value: "green", label: "Green", swatch: "#1e8066" },
] as const satisfies ReadonlyArray<{ value: ThemeAccent; label: string; swatch: string }>;

const THEME_STORAGE_KEY = "kikoto:theme";
const THEME_ACCENT_STORAGE_KEY = "kikoto:theme-accent";
export const THEME_CHANGE_EVENT = "kikoto:theme-change";
export const THEME_ACCENT_CHANGE_EVENT = "kikoto:theme-accent-change";
const darkModeQuery = "(prefers-color-scheme: dark)";

const themeColorByMode: Record<"light" | "dark", string> = {
  light: "#f5f6f8",
  dark: "#0f1115",
};

export function getStoredThemeMode(): ThemeMode {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storeThemeMode(mode: ThemeMode) {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent<ThemeMode>(THEME_CHANGE_EVENT, { detail: mode }));
}

export function getStoredThemeAccent(): ThemeAccent {
  const value = localStorage.getItem(THEME_ACCENT_STORAGE_KEY);
  return value === "blue" || value === "green" || value === "pink" ? value : DEFAULT_THEME_ACCENT;
}

export function storeThemeAccent(accent: ThemeAccent) {
  localStorage.setItem(THEME_ACCENT_STORAGE_KEY, accent);
  window.dispatchEvent(new CustomEvent<ThemeAccent>(THEME_ACCENT_CHANGE_EVENT, { detail: accent }));
}

export function systemPrefersDark() {
  return window.matchMedia(darkModeQuery).matches;
}

export function resolvedThemeMode(mode: ThemeMode) {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

export function applyThemeMode(mode: ThemeMode) {
  const resolved = resolvedThemeMode(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  updateThemeColor(resolved);
}

export function applyThemeAccent(accent: ThemeAccent) {
  document.documentElement.dataset.themeAccent = accent;
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia(darkModeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function updateThemeColor(mode: "light" | "dark") {
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColorByMode[mode]);
}

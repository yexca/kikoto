export type ThemeMode = "light" | "dark" | "system";
export type ThemeAccent = "pink" | "blue" | "green";

const THEME_STORAGE_KEY = "kikoto:theme";
const THEME_ACCENT_STORAGE_KEY = "kikoto:theme-accent";
export const THEME_CHANGE_EVENT = "kikoto:theme-change";
export const THEME_ACCENT_CHANGE_EVENT = "kikoto:theme-accent-change";
const darkModeQuery = "(prefers-color-scheme: dark)";

const themeColorByAccent: Record<ThemeAccent, { light: string; dark: string }> = {
  pink: { light: "#b32d57", dark: "#f47ca0" },
  blue: { light: "#2069c8", dark: "#6da9f7" },
  green: { light: "#29905b", dark: "#62da94" },
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
  return value === "blue" || value === "green" || value === "pink" ? value : "pink";
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
  updateThemeColor(resolved, getStoredThemeAccent());
}

export function applyThemeAccent(accent: ThemeAccent) {
  document.documentElement.dataset.themeAccent = accent;
  updateThemeColor(resolvedThemeMode(getStoredThemeMode()), accent);
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia(darkModeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function updateThemeColor(mode: "light" | "dark", accent: ThemeAccent) {
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", themeColorByAccent[accent][mode]);
}

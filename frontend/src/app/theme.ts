export type ThemeMode = "light" | "dark" | "system";

const THEME_STORAGE_KEY = "kikoto:theme";
const darkModeQuery = "(prefers-color-scheme: dark)";

export function getStoredThemeMode(): ThemeMode {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function storeThemeMode(mode: ThemeMode) {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
}

export function systemPrefersDark() {
  return window.matchMedia(darkModeQuery).matches;
}

export function resolvedThemeMode(mode: ThemeMode) {
  return mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
}

export function applyThemeMode(mode: ThemeMode) {
  document.documentElement.classList.toggle("dark", resolvedThemeMode(mode) === "dark");
}

export function watchSystemTheme(onChange: () => void) {
  const media = window.matchMedia(darkModeQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

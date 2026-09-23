import type { LibrarySource } from "@/lib/api";

export type LibrarySourceVisibilityMode = "auto" | "always" | "never";

export type LibrarySourceVisibilityKey = "local" | "tracked" | `remote:${number}`;

export type LibrarySourceVisibilityPreferences = Partial<
  Record<LibrarySourceVisibilityKey, Exclude<LibrarySourceVisibilityMode, "auto">>
>;

export const librarySourceVisibilityModes: readonly LibrarySourceVisibilityMode[] = ["auto", "always", "never"];

const storagePrefix = "kikoto:library-source-visibility:";

export function remoteSourceVisibilityKey(sourceID: number): LibrarySourceVisibilityKey {
  return `remote:${sourceID}`;
}

export function librarySourceVisibilityMode(
  preferences: LibrarySourceVisibilityPreferences,
  key: LibrarySourceVisibilityKey,
): LibrarySourceVisibilityMode {
  return preferences[key] ?? "auto";
}

export function withLibrarySourceVisibilityMode(
  preferences: LibrarySourceVisibilityPreferences,
  key: LibrarySourceVisibilityKey,
  mode: LibrarySourceVisibilityMode,
): LibrarySourceVisibilityPreferences {
  const next = { ...preferences };
  if (mode === "auto") delete next[key];
  else next[key] = mode;
  return next;
}

/**
 * Automatic visibility: Local is always shown, Tracked is shown once any tracked
 * work exists (null while unknown), and a remote source is shown while enabled.
 */
export function autoLibrarySourceVisible(
  key: LibrarySourceVisibilityKey,
  context: { hasTrackedWorks: boolean | null; source?: LibrarySource },
) {
  if (key === "local") return true;
  if (key === "tracked") return context.hasTrackedWorks === true;
  return context.source?.enabled === true;
}

export function librarySourceVisible(mode: LibrarySourceVisibilityMode, autoVisible: boolean) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return autoVisible;
}

export function readLibrarySourceVisibility(scope: string): LibrarySourceVisibilityPreferences {
  try {
    const raw = window.localStorage.getItem(`${storagePrefix}${scope}`);
    if (!raw) return {};
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const preferences: LibrarySourceVisibilityPreferences = {};
    for (const [key, mode] of Object.entries(value)) {
      if (!isVisibilityKey(key) || (mode !== "always" && mode !== "never")) continue;
      preferences[key] = mode;
    }
    return preferences;
  } catch {
    return {};
  }
}

export function writeLibrarySourceVisibility(scope: string, preferences: LibrarySourceVisibilityPreferences) {
  try {
    if (Object.keys(preferences).length === 0) window.localStorage.removeItem(`${storagePrefix}${scope}`);
    else window.localStorage.setItem(`${storagePrefix}${scope}`, JSON.stringify(preferences));
  } catch {
    // The source bar still uses automatic visibility when local storage is unavailable.
  }
}

function isVisibilityKey(key: string): key is LibrarySourceVisibilityKey {
  return key === "local" || key === "tracked" || /^remote:[1-9]\d*$/.test(key);
}

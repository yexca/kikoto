import { localStore, type StorageKey } from "@/lib/clientStorage";

/**
 * Per-viewer source visibility shared by source switchers: each source is
 * shown automatically, always, or never, and only explicit choices are stored.
 */
export type SourceVisibilityMode = "auto" | "always" | "never";

export type SourceVisibilityKey = "local" | "tracked" | `remote:${number}`;

export type SourceVisibilityPreferences = Partial<Record<SourceVisibilityKey, Exclude<SourceVisibilityMode, "auto">>>;

export const sourceVisibilityModes: readonly SourceVisibilityMode[] = ["auto", "always", "never"];

export function remoteSourceVisibilityKey(sourceID: number): SourceVisibilityKey {
  return `remote:${sourceID}`;
}

export function sourceVisibilityMode(
  preferences: SourceVisibilityPreferences,
  key: SourceVisibilityKey,
): SourceVisibilityMode {
  return preferences[key] ?? "auto";
}

export function withSourceVisibilityMode(
  preferences: SourceVisibilityPreferences,
  key: SourceVisibilityKey,
  mode: SourceVisibilityMode,
): SourceVisibilityPreferences {
  const next = { ...preferences };
  if (mode === "auto") delete next[key];
  else next[key] = mode;
  return next;
}

export function sourceVisible(mode: SourceVisibilityMode, autoVisible: boolean) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return autoVisible;
}

export function readSourceVisibility(storageKey: StorageKey): SourceVisibilityPreferences {
  const value = localStore.readJSON(storageKey);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const preferences: SourceVisibilityPreferences = {};
  for (const [key, mode] of Object.entries(value)) {
    if (!isVisibilityKey(key) || (mode !== "always" && mode !== "never")) continue;
    preferences[key] = mode;
  }
  return preferences;
}

// Switchers fall back to automatic visibility when local storage is unavailable.
export function writeSourceVisibility(storageKey: StorageKey, preferences: SourceVisibilityPreferences) {
  if (Object.keys(preferences).length === 0) localStore.remove(storageKey);
  else localStore.writeJSON(storageKey, preferences);
}

function isVisibilityKey(key: string): key is SourceVisibilityKey {
  return key === "local" || key === "tracked" || /^remote:[1-9]\d*$/.test(key);
}

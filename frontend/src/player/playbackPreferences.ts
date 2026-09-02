import { currentScopedStorageKey, type ClientPrincipalID } from "@/lib/clientStorageScope";

export type PlaybackSeekPreferences = {
  seekForwardSeconds: number;
  seekBackwardSeconds: number;
};

export const DEFAULT_SEEK_FORWARD_SECONDS = 30;
export const DEFAULT_SEEK_BACKWARD_SECONDS = 10;
export const SEEK_SECONDS_MIN = 1;
export const SEEK_SECONDS_MAX = 300;

export const PLAYER_SEEK_PREFERENCES_CHANGE_EVENT = "kikoto:player-seek-preferences-change";

const PLAYBACK_SEEK_PREFERENCES_STORAGE_BASE_KEY = "kikoto:player-seek-preferences:v1";

export function defaultPlaybackSeekPreferences(): PlaybackSeekPreferences {
  return {
    seekForwardSeconds: DEFAULT_SEEK_FORWARD_SECONDS,
    seekBackwardSeconds: DEFAULT_SEEK_BACKWARD_SECONDS,
  };
}

export function playbackSeekPreferencesStorageKey(principalID: ClientPrincipalID) {
  return currentScopedStorageKey(PLAYBACK_SEEK_PREFERENCES_STORAGE_BASE_KEY, principalID);
}

export function normalizeSeekSeconds(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return value >= SEEK_SECONDS_MIN && value <= SEEK_SECONDS_MAX ? value : fallback;
}

export function normalizePlaybackSeekPreferences(value: unknown): PlaybackSeekPreferences {
  const defaults = defaultPlaybackSeekPreferences();
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const candidate = value as Partial<Record<keyof PlaybackSeekPreferences, unknown>>;
  return {
    seekForwardSeconds: normalizeSeekSeconds(candidate.seekForwardSeconds, defaults.seekForwardSeconds),
    seekBackwardSeconds: normalizeSeekSeconds(candidate.seekBackwardSeconds, defaults.seekBackwardSeconds),
  };
}

export function getStoredPlaybackSeekPreferences(principalID: ClientPrincipalID): PlaybackSeekPreferences {
  try {
    const raw = localStorage.getItem(playbackSeekPreferencesStorageKey(principalID));
    return normalizePlaybackSeekPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPlaybackSeekPreferences();
  }
}

export function storePlaybackSeekPreferences(
  principalID: ClientPrincipalID,
  value: PlaybackSeekPreferences | Partial<PlaybackSeekPreferences>,
) {
  const preferences = normalizePlaybackSeekPreferences(value);
  const storageKey = playbackSeekPreferencesStorageKey(principalID);
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Playback remains usable when browser storage is unavailable or full.
  }
  window.dispatchEvent(
    new CustomEvent<PlaybackSeekPreferencesChangeDetail>(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, {
      detail: { storageKey, preferences },
    }),
  );
  return preferences;
}

export type PlaybackSeekPreferencesChangeDetail = {
  storageKey: string;
  preferences: PlaybackSeekPreferences;
};

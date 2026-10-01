import { useEffect, useState } from "react";

import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import {
  getStoredPlaybackSourcePreferences,
  playbackSourcePreferencesStorageKey,
  PLAYER_SOURCE_PREFERENCES_CHANGE_EVENT,
  type PlaybackSourcePreferences,
  type PlaybackSourcePreferencesChangeDetail,
} from "./playbackPreferences";

/** The account's source switching and fallback choices, kept in sync with Settings and other tabs. */
export function usePlaybackSourcePreferences(principalID: ClientPrincipalID) {
  const storageKey = playbackSourcePreferencesStorageKey(principalID);
  const [preferences, setPreferences] = useState<PlaybackSourcePreferences>(() =>
    getStoredPlaybackSourcePreferences(principalID),
  );

  useEffect(() => {
    setPreferences(getStoredPlaybackSourcePreferences(principalID));
    const syncCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<PlaybackSourcePreferencesChangeDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      setPreferences(detail.preferences);
    };
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setPreferences(getStoredPlaybackSourcePreferences(principalID));
    };
    window.addEventListener(PLAYER_SOURCE_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(PLAYER_SOURCE_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, [principalID, storageKey]);

  return preferences;
}

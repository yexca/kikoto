import { useEffect, useState } from "react";

import type { PlayerTrack } from "./playerTypes";

/**
 * Whether the lock screen, Control Center, and media notifications show only
 * the app name. The choice belongs to the device rather than an account, so a
 * different sign-in cannot expose the track. Off by default.
 */
export const SYSTEM_MEDIA_DETAILS_HIDDEN_STORAGE_KEY = "kikoto:system-media-details-hidden:v1";
export const SYSTEM_MEDIA_PRIVACY_CHANGE_EVENT = "kikoto:system-media-privacy-change";

const APP_NAME = "Kikoto";

export function getSystemMediaDetailsHidden() {
  try {
    return localStorage.getItem(SYSTEM_MEDIA_DETAILS_HIDDEN_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function storeSystemMediaDetailsHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(SYSTEM_MEDIA_DETAILS_HIDDEN_STORAGE_KEY, "true");
    else localStorage.removeItem(SYSTEM_MEDIA_DETAILS_HIDDEN_STORAGE_KEY);
  } catch {
    // The choice still applies to this page when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<boolean>(SYSTEM_MEDIA_PRIVACY_CHANGE_EVENT, { detail: hidden }));
}

export function useSystemMediaDetailsHidden() {
  const [hidden, setHidden] = useState(getSystemMediaDetailsHidden);
  useEffect(() => {
    const syncCustomEvent = (event: Event) => setHidden((event as CustomEvent<boolean>).detail === true);
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key === SYSTEM_MEDIA_DETAILS_HIDDEN_STORAGE_KEY) setHidden(getSystemMediaDetailsHidden());
    };
    window.addEventListener(SYSTEM_MEDIA_PRIVACY_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(SYSTEM_MEDIA_PRIVACY_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, []);
  return hidden;
}

export type SystemMediaDetails = {
  title: string;
  artist: string;
  album: string;
  /** Relative asset path, or empty when no artwork is shown. */
  coverUrl: string;
};

/** What the operating system's media surfaces show for a track. */
export function systemMediaDetails(track: PlayerTrack, hidden: boolean): SystemMediaDetails {
  if (hidden) return { title: APP_NAME, artist: "", album: "", coverUrl: "" };
  return {
    title: track.title || track.workTitle || APP_NAME,
    artist: track.circle || track.workTitle || APP_NAME,
    album: track.workTitle || track.workCode || APP_NAME,
    coverUrl: track.coverUrl,
  };
}

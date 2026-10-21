import { useNativePrivacySettings } from "@/hooks/useNativePrivacySettings";
import { supportsNativePrivacy, type LockScreenMediaContent } from "@/lib/nativePrivacy";

import { playerTrackTitle } from "./playerTrackTitle";
import type { PlayerTrack } from "./playerTypes";

const APP_NAME = "Kikoto";

/**
 * What the Media Session shows. The iOS shell applies the device's choice
 * there, because its lock screen and Control Center read the page's Media
 * Session and cannot tell whether the device is locked. The Android media
 * notification applies the choice natively while the device is locked, and a
 * browser shows everything.
 */
export function useMediaSessionContent(): LockScreenMediaContent {
  const { settings } = useNativePrivacySettings();
  return supportsNativePrivacy() ? settings.lockScreenContent : "full";
}

export type SystemMediaDetails = {
  title: string;
  artist: string;
  album: string;
  /** Relative asset path, or empty when no artwork is shown. */
  coverUrl: string;
};

/**
 * What the operating system's media surfaces show for a track. The title is
 * the track's display name unless the listener asked for real file names.
 */
export function systemMediaDetails(
  track: PlayerTrack,
  content: LockScreenMediaContent,
  originalNames = false,
): SystemMediaDetails {
  if (content === "hidden") return { title: APP_NAME, artist: "", album: "", coverUrl: "" };
  return {
    title: playerTrackTitle(track, originalNames) || track.workTitle || APP_NAME,
    artist: track.circle || track.workTitle || APP_NAME,
    album: track.workTitle || track.workCode || APP_NAME,
    coverUrl: content === "full" ? track.coverUrl : "",
  };
}

import { useEffect, useRef, useState } from "react";

import { api, type MediaLoudness } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import { resumeLoudnessGain, routeLoudnessGain } from "./loudnessBoost";
import {
  getStoredLoudnessMode,
  loudnessGain,
  loudnessPreferenceStorageKey,
  PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT,
  type LoudnessNormalizationMode,
  type LoudnessPreferenceChangeDetail,
} from "./loudnessNormalization";
import type { PlayerTrack } from "./playerTypes";
import { applyElementVolume, type PlaybackEngine } from "./usePlaybackEngine";

/** The account's loudness normalization choice, kept in sync with Settings and other tabs. */
export function useLoudnessNormalizationMode(principalID: ClientPrincipalID) {
  const storageKey = loudnessPreferenceStorageKey(principalID);
  const [mode, setMode] = useState<LoudnessNormalizationMode>(() => getStoredLoudnessMode(principalID));

  useEffect(() => {
    setMode(getStoredLoudnessMode(principalID));
    const syncCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<LoudnessPreferenceChangeDetail>).detail;
      if (detail?.storageKey === storageKey) setMode(detail.mode);
    };
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key === storageKey) setMode(getStoredLoudnessMode(principalID));
    };
    window.addEventListener(PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, [principalID, storageKey]);

  return mode;
}

/** Loudness is measured for local library files only. */
function measurableLocationId(track: PlayerTrack | null) {
  return track?.locationType === "local" && track.locationId > 0 ? track.locationId : null;
}

/**
 * Applies loudness normalization to the current track. Nothing is requested
 * while it is off. The current and the next track are measured on demand; a
 * track plays at its own level until its measurement arrives.
 */
export function useLoudnessNormalization(
  engine: PlaybackEngine,
  mode: LoudnessNormalizationMode,
  nextTrack: PlayerTrack | null,
) {
  const { refs, currentTrack, isPlaying, currentPlaybackInstanceKey } = engine;
  const knownRef = useRef(new Map<number, MediaLoudness>());
  const pendingRef = useRef(new Set<number>());
  const [measured, setMeasured] = useState(0);
  const locationId = measurableLocationId(currentTrack);
  const nextLocationId = measurableLocationId(nextTrack);

  // A measurement keeps running when the track changes, since the next track
  // usually becomes the current one; only leaving the player cancels it.
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mode === "off") return;
    controllerRef.current ??= new AbortController();
    const { signal } = controllerRef.current;
    for (const id of [locationId, nextLocationId]) {
      if (id === null || knownRef.current.has(id) || pendingRef.current.has(id)) continue;
      pendingRef.current.add(id);
      api
        .getMediaLoudness(id, signal)
        .then((loudness) => {
          knownRef.current.set(id, loudness);
          setMeasured((value) => value + 1);
        })
        // An unavailable or busy measurement leaves the track at its own level;
        // the next time it plays asks again.
        .catch(() => {})
        .finally(() => pendingRef.current.delete(id));
    }
  }, [locationId, mode, nextLocationId]);

  const loudness = locationId === null ? undefined : knownRef.current.get(locationId);
  const gain = loudnessGain(loudness, mode);

  useEffect(() => {
    const routed = routeLoudnessGain(refs.audioRef.current, gain, mode === "full");
    refs.loudnessVolumeRef.current = routed ? 1 : Math.min(1, gain);
    applyElementVolume(refs);
  }, [currentPlaybackInstanceKey, gain, measured, mode, refs]);

  useEffect(() => {
    if (isPlaying) resumeLoudnessGain(refs.audioRef.current);
  }, [isPlaying, refs]);
}

import { useEffect, useRef, useState } from "react";

import { api, ApiError, type MediaLoudness } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import {
  isLoudnessRouted,
  prepareStandbyElement,
  releaseLoudnessGain,
  resumeLoudnessGain,
  routeLoudnessGain,
  unlockLoudnessGain,
} from "./loudnessBoost";
import {
  createMeasurementRetries,
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

/** A change of the element volume while a track plays takes this long, in milliseconds. */
const VOLUME_RAMP_MS = 400;
const VOLUME_RAMP_STEP_MS = 20;
/** A busy server is asked again after this long, in milliseconds. */
const MEASUREMENT_BUSY_RETRY_MS = 5000;
/** Input that lets a page start Web Audio. */
const USER_GESTURE_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/**
 * Moves the loudness part of the element volume to target, gradually while
 * the track plays, so a measurement that arrives mid-track does not jump the
 * level. Returns a cancel function; a cancelled ramp keeps its current level.
 */
function rampElementLoudness(refs: PlaybackEngine["refs"], target: number, ramp: boolean) {
  const from = refs.loudnessVolumeRef.current;
  if (!ramp || from === target) {
    refs.loudnessVolumeRef.current = target;
    applyElementVolume(refs);
    return () => {};
  }
  const started = performance.now();
  const timer = window.setInterval(() => {
    const progress = Math.min(1, (performance.now() - started) / VOLUME_RAMP_MS);
    refs.loudnessVolumeRef.current = from + (target - from) * progress;
    applyElementVolume(refs);
    if (progress >= 1) window.clearInterval(timer);
  }, VOLUME_RAMP_STEP_MS);
  return () => window.clearInterval(timer);
}

/**
 * Applies loudness normalization to the current track. Nothing is requested
 * while it is off. The current track is measured on demand, then the next one;
 * a track plays at its own level until its measurement arrives, and then moves
 * to the new level smoothly. Returns whether the player keeps a standby
 * element, which replaces an element Web Audio holds once that element has
 * to play through its own output again.
 */
export function useLoudnessNormalization(
  engine: PlaybackEngine,
  mode: LoudnessNormalizationMode,
  nextTrack: PlayerTrack | null,
) {
  const { refs, currentTrack, isPlaying, currentPlaybackInstanceKey, audioElementKey, replaceAudioElement } = engine;
  const knownRef = useRef(new Map<number, MediaLoudness>());
  const pendingRef = useRef(new Set<number>());
  const [measured, setMeasured] = useState(0);
  // Bumped when Web Audio may route now: its context started, the page became
  // visible, or a gesture followed a silent route.
  const [audioReady, setAudioReady] = useState(0);
  const [routed, setRouted] = useState(false);
  // Set when a routed element went silent; the next gesture lets the element
  // that replaced it route again.
  const silencedRef = useRef(false);
  const modeRef = useRef(mode);
  const appliedInstanceRef = useRef<string | null>(null);
  const locationId = measurableLocationId(currentTrack);
  const nextLocationId = measurableLocationId(nextTrack);

  // A measurement keeps running when the track changes, since the next track
  // usually becomes the current one; only leaving the player cancels it. A
  // player that mounts again, as under StrictMode, measures with a new
  // controller and forgets the cancelled requests.
  const controllerRef = useRef<AbortController | null>(null);
  const retriesRef = useRef(createMeasurementRetries(MEASUREMENT_BUSY_RETRY_MS));
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      pendingRef.current = new Set();
      retriesRef.current.clear();
    },
    [],
  );

  // A measurement that failed is not asked for again until another track
  // starts; a busy server is asked again shortly.
  const failedRef = useRef(new Set<number>());
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    failedRef.current.clear();
  }, [locationId]);

  // The server measures one file at a time, so the current track goes first
  // and the next one follows.
  useEffect(() => {
    if (mode === "off") return;
    const pending = pendingRef.current;
    if (pending.size > 0) return;
    const id = [locationId, nextLocationId].find(
      (candidate): candidate is number =>
        candidate !== null && !knownRef.current.has(candidate) && !failedRef.current.has(candidate),
    );
    if (id === undefined) return;
    controllerRef.current ??= new AbortController();
    const { signal } = controllerRef.current;
    pending.add(id);
    api
      .getMediaLoudness(id, signal)
      .then((loudness) => {
        knownRef.current.set(id, loudness);
        setMeasured((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        // An unavailable measurement leaves the track at its own level.
        failedRef.current.add(id);
        if (error instanceof ApiError && error.code === "media_loudness_busy") {
          retriesRef.current.schedule(id, () => {
            failedRef.current.delete(id);
            setSettled((value) => value + 1);
          });
        }
      })
      .finally(() => {
        if (pendingRef.current !== pending) return;
        pending.delete(id);
        setSettled((value) => value + 1);
      });
  }, [locationId, mode, nextLocationId, settled]);

  const loudness = locationId === null ? undefined : knownRef.current.get(locationId);
  const gain = loudnessGain(loudness, mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Safari starts Web Audio only from a user gesture, and a routed element is
  // silent until its context runs, so every gesture resumes it. The same
  // gesture prepares the standby element so it can take over without one.
  useEffect(() => {
    const unlock = () => {
      unlockLoudnessGain(refs.audioRef.current, modeRef.current === "full");
      prepareStandbyElement(refs.standbyAudioRef.current);
      if (silencedRef.current) {
        silencedRef.current = false;
        setAudioReady((value) => value + 1);
      }
    };
    // Settings stores a new mode inside the gesture that chose it, before the
    // player renders that mode, so choosing full normalization unlocks here.
    const modeChange = (event: Event) => {
      if ((event as CustomEvent<LoudnessPreferenceChangeDetail>).detail?.mode === "full") {
        unlockLoudnessGain(refs.audioRef.current, true);
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") setAudioReady((value) => value + 1);
    };
    for (const type of USER_GESTURE_EVENTS) window.addEventListener(type, unlock, { capture: true, passive: true });
    window.addEventListener(PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT, modeChange);
    document.addEventListener("visibilitychange", visible);
    // Play requests from the page, media keys, and the lock screen run inside
    // the gesture that made them.
    const playRequestRef = refs.playRequestRef;
    playRequestRef.current = () => resumeLoudnessGain(refs.audioRef.current);
    return () => {
      for (const type of USER_GESTURE_EVENTS) window.removeEventListener(type, unlock, { capture: true });
      window.removeEventListener(PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT, modeChange);
      document.removeEventListener("visibilitychange", visible);
      playRequestRef.current = () => {};
    };
  }, [refs]);

  // A replaced element's context is closed.
  const contextElementRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = refs.audioRef.current;
    const previous = contextElementRef.current;
    if (previous && previous !== audio) releaseLoudnessGain(previous);
    contextElementRef.current = audio;
  }, [audioElementKey, refs]);
  useEffect(
    () => () => {
      // An element that is still on the page, as under StrictMode, keeps its context.
      const audio = contextElementRef.current;
      if (audio && !audio.isConnected) releaseLoudnessGain(audio);
    },
    [],
  );

  useEffect(() => {
    const audio = refs.audioRef.current;
    // A new track starts at its level; a change within a track moves smoothly.
    const sameTrack = appliedInstanceRef.current === currentPlaybackInstanceKey;
    appliedInstanceRef.current = currentPlaybackInstanceKey;
    const ramp = sameTrack && Boolean(audio && !audio.paused);
    const elementRouted = routeLoudnessGain(audio, gain, {
      allowRouting: mode === "full" && !silencedRef.current,
      currentGain: refs.loudnessVolumeRef.current,
      ramp,
      onRunning: () => setAudioReady((value) => value + 1),
      // Playback that cannot be heard moves to an element's own output at
      // once, at the unboosted level; routing waits for the next gesture.
      onSilent: () => {
        silencedRef.current = true;
        replaceAudioElement();
      },
    });
    setRouted(elementRouted);
    return rampElementLoudness(refs, elementRouted ? 1 : Math.min(1, gain), ramp && !elementRouted);
  }, [audioElementKey, audioReady, currentPlaybackInstanceKey, gain, measured, mode, refs, replaceAudioElement]);

  // Leaving full normalization returns playback to an element's own output
  // without cutting into the current track: the routed element keeps playing
  // until it pauses or the next track starts, and is replaced then.
  const releaseInstanceRef = useRef<string | null>(null);
  useEffect(() => {
    // The routed state renders the standby element; the element itself tells
    // whether it still needs replacing.
    if (mode === "full" || !isLoudnessRouted(refs.audioRef.current)) {
      releaseInstanceRef.current = null;
      return;
    }
    releaseInstanceRef.current ??= currentPlaybackInstanceKey;
    if (isPlaying && releaseInstanceRef.current === currentPlaybackInstanceKey) return;
    releaseInstanceRef.current = null;
    replaceAudioElement();
  }, [audioElementKey, currentPlaybackInstanceKey, isPlaying, mode, refs, replaceAudioElement, routed]);

  return mode === "full" || routed;
}

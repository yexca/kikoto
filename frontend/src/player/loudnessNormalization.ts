import { currentScopedStorageKey, type ClientPrincipalID } from "@/lib/clientStorageScope";
import type { MediaLoudness } from "@/lib/api";

/**
 * How playback evens out the loudness of tracks. "attenuate" only turns loud
 * tracks down, through the media element's own volume. "full" also turns quiet
 * tracks up, which needs Web Audio and stays opt-in.
 */
export type LoudnessNormalizationMode = "off" | "attenuate" | "full";

export const LOUDNESS_NORMALIZATION_MODES: readonly LoudnessNormalizationMode[] = ["off", "attenuate", "full"];

/** The integrated loudness every track is brought towards, as in ReplayGain 2.0. */
export const LOUDNESS_TARGET_LUFS = -18;
/** A boost leaves this much headroom below the measured peak, so it never clips. */
const BOOST_PEAK_HEADROOM_DB = 1;
/** Neither direction moves a track more than this. */
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = 24;

export const PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT = "kikoto:player-loudness-preference-change";
const LOUDNESS_PREFERENCE_STORAGE_BASE_KEY = "kikoto:player-loudness-normalization:v1";

export type LoudnessPreferenceChangeDetail = {
  storageKey: string;
  mode: LoudnessNormalizationMode;
};

export function loudnessPreferenceStorageKey(principalID: ClientPrincipalID) {
  return currentScopedStorageKey(LOUDNESS_PREFERENCE_STORAGE_BASE_KEY, principalID);
}

export function normalizeLoudnessMode(value: unknown): LoudnessNormalizationMode {
  return LOUDNESS_NORMALIZATION_MODES.includes(value as LoudnessNormalizationMode)
    ? (value as LoudnessNormalizationMode)
    : "off";
}

export function getStoredLoudnessMode(principalID: ClientPrincipalID): LoudnessNormalizationMode {
  try {
    return normalizeLoudnessMode(localStorage.getItem(loudnessPreferenceStorageKey(principalID)));
  } catch {
    return "off";
  }
}

export function storeLoudnessMode(principalID: ClientPrincipalID, value: LoudnessNormalizationMode) {
  const mode = normalizeLoudnessMode(value);
  const storageKey = loudnessPreferenceStorageKey(principalID);
  try {
    localStorage.setItem(storageKey, mode);
  } catch {
    // The choice still applies to this page when browser storage is unavailable or full.
  }
  window.dispatchEvent(
    new CustomEvent<LoudnessPreferenceChangeDetail>(PLAYER_LOUDNESS_PREFERENCE_CHANGE_EVENT, {
      detail: { storageKey, mode },
    }),
  );
  return mode;
}

/**
 * The linear gain that brings a track towards the target loudness. A cut
 * applies in both modes; a boost only in "full", limited so the measured peak
 * stays below full scale.
 */
export function loudnessGain(loudness: MediaLoudness | null | undefined, mode: LoudnessNormalizationMode) {
  if (mode === "off" || !loudness || !Number.isFinite(loudness.integratedLufs)) return 1;
  let gainDb = LOUDNESS_TARGET_LUFS - loudness.integratedLufs;
  if (gainDb > 0) {
    if (mode !== "full") return 1;
    const peakLimit = Number.isFinite(loudness.peakDbfs) ? -BOOST_PEAK_HEADROOM_DB - loudness.peakDbfs : 0;
    gainDb = Math.min(gainDb, peakLimit, MAX_BOOST_DB);
    if (gainDb <= 0) return 1;
  } else {
    gainDb = Math.max(gainDb, -MAX_CUT_DB);
  }
  return 10 ** (gainDb / 20);
}

/**
 * Timers that ask a busy server again for a measurement, one per file, so a
 * retry for the next track never replaces the current track's.
 */
export function createMeasurementRetries(delayMs: number) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    schedule(id: number, retry: () => void) {
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          retry();
        }, delayMs),
      );
    },
    clear() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

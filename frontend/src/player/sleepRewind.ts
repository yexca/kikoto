import { currentScopedStorageKey, type ClientPrincipalID } from "@/lib/clientStorageScope";

export const SLEEP_REWIND_MINUTES_MIN = 0;
export const SLEEP_REWIND_MINUTES_MAX = 120;
export const DEFAULT_SLEEP_REWIND_MINUTES = 0;

export const SLEEP_REWIND_CHANGE_EVENT = "kikoto:player-sleep-rewind-change";

const SLEEP_REWIND_STORAGE_BASE_KEY = "kikoto:player-sleep-rewind:v1";

export type SleepRewindChangeDetail = {
  storageKey: string;
  minutes: number;
};

export function sleepRewindStorageKey(principalID: ClientPrincipalID) {
  return currentScopedStorageKey(SLEEP_REWIND_STORAGE_BASE_KEY, principalID);
}

export function normalizeSleepRewindMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return DEFAULT_SLEEP_REWIND_MINUTES;
  return value >= SLEEP_REWIND_MINUTES_MIN && value <= SLEEP_REWIND_MINUTES_MAX ? value : DEFAULT_SLEEP_REWIND_MINUTES;
}

/** A draft typed into the menu is accepted only as a whole number inside the range. */
export function parseSleepRewindDraft(value: string) {
  if (!/^\d{1,3}$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  return minutes >= SLEEP_REWIND_MINUTES_MIN && minutes <= SLEEP_REWIND_MINUTES_MAX ? minutes : null;
}

export function getStoredSleepRewindMinutes(principalID: ClientPrincipalID) {
  try {
    const raw = localStorage.getItem(sleepRewindStorageKey(principalID));
    const parsed = raw ? (JSON.parse(raw) as { minutes?: unknown } | null) : null;
    return normalizeSleepRewindMinutes(parsed?.minutes);
  } catch {
    return DEFAULT_SLEEP_REWIND_MINUTES;
  }
}

export function storeSleepRewindMinutes(principalID: ClientPrincipalID, value: number) {
  const minutes = normalizeSleepRewindMinutes(value);
  const storageKey = sleepRewindStorageKey(principalID);
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, minutes }));
  } catch {
    // The setting applies for this session when browser storage is unavailable.
  }
  window.dispatchEvent(
    new CustomEvent<SleepRewindChangeDetail>(SLEEP_REWIND_CHANGE_EVENT, { detail: { storageKey, minutes } }),
  );
  return minutes;
}

export type SleepStopInput = {
  rewindMinutes: number;
  /** Playback was active when the timer fired. A listener who already paused keeps their position. */
  wasPlaying: boolean;
  /** A start position still waiting for media metadata, when the element has not applied it yet. */
  unappliedStartSeconds: number | null;
  /** A seek the element has not confirmed yet. */
  pendingSeekSeconds: number | null;
  elementPositionSeconds: number;
  /** The finish-current-track timer fired from the track's end. */
  ended: boolean;
  durationSeconds: number;
};

export type SleepStopPlan =
  | { kind: "none" }
  /** Move the not-yet-applied start position; nothing was heard, so no cursor is written. */
  | { kind: "start"; positionSeconds: number }
  /** Seek the element back within the current track and persist that position. */
  | { kind: "seek"; positionSeconds: number };

/** Where playback should rest after the sleep timer stops it, rewound within the current track. */
export function planSleepStop(input: SleepStopInput): SleepStopPlan {
  const rewindSeconds = normalizeSleepRewindMinutes(input.rewindMinutes) * 60;
  if (rewindSeconds <= 0 || !input.wasPlaying) return { kind: "none" };
  if (input.unappliedStartSeconds !== null && Number.isFinite(input.unappliedStartSeconds)) {
    return { kind: "start", positionSeconds: Math.max(0, input.unappliedStartSeconds - rewindSeconds) };
  }
  const base = input.ended
    ? (positiveFinite(input.durationSeconds) ?? input.elementPositionSeconds)
    : (input.pendingSeekSeconds ?? input.elementPositionSeconds);
  if (!Number.isFinite(base) || base < 0) return { kind: "none" };
  return { kind: "seek", positionSeconds: Math.max(0, base - rewindSeconds) };
}

function positiveFinite(value: number) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

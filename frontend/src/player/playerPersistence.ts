import { deviceKey, localStore, type ClientStore, type StorageKey } from "@/lib/clientStorage";

import type { DockMode, PlaybackCompatibilityScope, PlayerTrack, PlayMode, SleepTimerState } from "./playerTypes";
import { withQueueIdentity } from "./playbackIdentity";

export const PLAYER_QUEUE_STORAGE_BASE_KEY = "kikoto:player-queue:v2";

export const OBSOLETE_PLAYER_PROGRESS_STORAGE_BASE_KEY = "kikoto:player-progress:v2";

// The first queue and progress shapes were kept for the whole device.
const LEGACY_PLAYER_QUEUE_STORAGE_KEY = deviceKey("kikoto:player-queue:v1");

const LEGACY_PLAYER_PROGRESS_STORAGE_KEY = deviceKey("kikoto:player-progress:v1");

const DOCK_MODE_STORAGE_KEY = deviceKey("kikoto:player-dock-mode:v1");

export const PLAYBACK_COMPATIBILITY_STORAGE_BASE_KEY = "kikoto:player-compatibility:v1";

export function isPlaybackCompatibilityScope(value: unknown): value is PlaybackCompatibilityScope {
  return value === "off" || value === "track" || value === "queue" || value === "always";
}

export function loadPersistedPlaybackCompatibility(storageKey: StorageKey): PlaybackCompatibilityScope {
  const parsed = localStore.readJSON(storageKey) as { version?: number; scope?: unknown } | null;
  return isPlaybackCompatibilityScope(parsed?.scope) && parsed.scope === "always" ? "always" : "off";
}

// Playback remains usable when browser storage is unavailable.
export function persistPlaybackCompatibility(storageKey: StorageKey, scope: PlaybackCompatibilityScope) {
  if (scope === "always") localStore.writeJSON(storageKey, { version: 1, scope: "always" });
  else localStore.remove(storageKey);
}

export function discardObsoletePlayerState(scopedProgressStorageKey: StorageKey, store: ClientStore = localStore) {
  store.remove(LEGACY_PLAYER_QUEUE_STORAGE_KEY);
  store.remove(LEGACY_PLAYER_PROGRESS_STORAGE_KEY);
  store.remove(scopedProgressStorageKey);
}

function isDockMode(value: unknown): value is DockMode {
  return value === "full" || value === "compact" || value === "mini";
}

function defaultDockMode(isMobile: boolean): DockMode {
  return isMobile ? "compact" : "full";
}

type StoredDockModes = { desktop?: DockMode; mobile?: DockMode } | null;

export function restoreDockMode(isMobile: boolean): DockMode {
  const stored = localStore.readJSON(DOCK_MODE_STORAGE_KEY) as StoredDockModes;
  const mode = isMobile ? stored?.mobile : stored?.desktop;
  return isDockMode(mode) ? mode : defaultDockMode(isMobile);
}

// Malformed local preferences are replaced with the next valid selection.
export function persistDockMode(isMobile: boolean, mode: DockMode) {
  const stored: { version: 1; desktop?: DockMode; mobile?: DockMode } = { version: 1 };
  const parsed = localStore.readJSON(DOCK_MODE_STORAGE_KEY) as StoredDockModes;
  if (isDockMode(parsed?.desktop)) stored.desktop = parsed.desktop;
  if (isDockMode(parsed?.mobile)) stored.mobile = parsed.mobile;
  if (isMobile) stored.mobile = mode;
  else stored.desktop = mode;
  localStore.writeJSON(DOCK_MODE_STORAGE_KEY, stored);
}

export function loadPersistedQueue(queueStorageKey: StorageKey, store: ClientStore = localStore) {
  return parsePersistedQueue(store.read(queueStorageKey));
}

// Playback continues when browser storage is unavailable or full.
export function persistQueue(queueStorageKey: StorageKey, stored: unknown) {
  localStore.writeJSON(queueStorageKey, stored);
}

export function parsePersistedQueue(
  raw: string | null,
  now = Date.now(),
): {
  queue: PlayerTrack[];
  currentIndex: number;
  mode: PlayMode;
  playbackRate: number;
  sleepTimer: SleepTimerState;
} {
  try {
    const parsed = JSON.parse(raw ?? "null") as {
      version?: number;
      queue?: PlayerTrack[];
      currentIndex?: number;
      mode?: PlayMode;
      playbackRate?: number;
      sleepTimer?: SleepTimerState | { mode: "track_end" };
    } | null;
    const queue = Array.isArray(parsed?.queue)
      ? parsed.queue
          .filter((track) => track && track.mediaItemId > 0 && track.streamUrl)
          .map((track) => ({
            ...track,
            kind: track.kind === "video" ? ("video" as const) : ("audio" as const),
            progress: null,
          }))
          .map(withQueueIdentity)
      : [];
    const currentIndex = Math.max(0, Math.min(queue.length - 1, Number(parsed?.currentIndex) || 0));
    const mode = parsed?.mode === "loop" || parsed?.mode === "single" ? parsed.mode : "order";
    const playbackRate = [0.75, 1, 1.25, 1.5, 2].includes(Number(parsed?.playbackRate))
      ? Number(parsed?.playbackRate)
      : 1;
    const rawSleepTimer = parsed?.sleepTimer;
    const sleepTimer: SleepTimerState =
      rawSleepTimer?.mode === "track_end"
        ? { mode: "deadline", deadline: now, finishCurrentTrack: true, waitingForTrackEnd: true }
        : rawSleepTimer?.mode === "deadline" && (rawSleepTimer.deadline > now || rawSleepTimer.waitingForTrackEnd)
          ? {
              mode: "deadline",
              deadline: rawSleepTimer.deadline,
              finishCurrentTrack: Boolean(rawSleepTimer.finishCurrentTrack),
              waitingForTrackEnd: Boolean(rawSleepTimer.waitingForTrackEnd),
            }
          : null;
    return { queue, currentIndex, mode, playbackRate, sleepTimer };
  } catch {
    return { queue: [], currentIndex: 0, mode: "order", playbackRate: 1, sleepTimer: null };
  }
}

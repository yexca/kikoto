import { useCallback, useEffect, useRef, useState } from "react";

import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import {
  getStoredPlaybackSeekPreferences,
  playbackSeekPreferencesStorageKey,
  PLAYER_SEEK_PREFERENCES_CHANGE_EVENT,
  type PlaybackSeekPreferences,
  type PlaybackSeekPreferencesChangeDetail,
} from "./playbackPreferences";
import type { PlaybackEngine } from "./usePlaybackEngine";

/** The account's seek step preferences, kept in sync with Settings and other tabs. */
export function usePlaybackSeekPreferences(principalID: ClientPrincipalID) {
  const storageKey = playbackSeekPreferencesStorageKey(principalID);
  const [seekPreferences, setSeekPreferences] = useState<PlaybackSeekPreferences>(() =>
    getStoredPlaybackSeekPreferences(principalID),
  );

  useEffect(() => {
    setSeekPreferences(getStoredPlaybackSeekPreferences(principalID));
    const syncCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<PlaybackSeekPreferencesChangeDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      setSeekPreferences(detail.preferences);
    };
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setSeekPreferences(getStoredPlaybackSeekPreferences(principalID));
    };
    window.addEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, [principalID, storageKey]);

  return seekPreferences;
}

// A seek the element has not confirmed within this window shows its actual position instead.
const PENDING_SEEK_TIMEOUT_MS = 3_000;

/**
 * Moves the element and tracks the seek until it is confirmed, so an older
 * timeupdate cannot briefly show or save the pre-seek position. It does not
 * count as listener intent; callers decide that. Returns false when the element
 * could not move.
 */
export function seekMediaElement(
  {
    refs,
    clearPendingSeek,
    commitCurrentTime,
  }: Pick<PlaybackEngine, "refs" | "clearPendingSeek" | "commitCurrentTime">,
  nextTime: number,
) {
  const audio = refs.audioRef.current;
  if (!audio) return false;
  clearPendingSeek();
  refs.pendingSeekTargetRef.current = nextTime;
  try {
    audio.currentTime = nextTime;
  } catch {
    refs.pendingSeekTargetRef.current = null;
    return false;
  }
  refs.pendingSeekTimerRef.current = window.setTimeout(() => {
    if (refs.pendingSeekTargetRef.current !== nextTime) return;
    clearPendingSeek();
    const currentAudio = refs.audioRef.current;
    if (!currentAudio) return;
    commitCurrentTime(currentAudio.currentTime);
    refs.nativeMediaSyncRef.current();
  }, PENDING_SEEK_TIMEOUT_MS);
  commitCurrentTime(nextTime);
  refs.nativeMediaSyncRef.current();
  return true;
}

/**
 * Seeking shows the requested position immediately and ignores stale time
 * updates until the element reaches it. A seek also counts as listener intent,
 * which lets the new position replace the Resume cursor.
 */
export function usePlayerSeeking(engine: PlaybackEngine, seekPreferences: PlaybackSeekPreferences) {
  const { refs, duration, clearPendingSeek, commitCurrentTime } = engine;
  // Seek steps are read when used so the step controls keep a stable identity.
  const seekPreferencesRef = useRef(seekPreferences);
  seekPreferencesRef.current = seekPreferences;

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = refs.audioRef.current;
      if (!audio || !Number.isFinite(seconds)) return;
      const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
      const nextTime = Math.max(0, Math.min(seconds, mediaDuration));
      if (!seekMediaElement({ refs, clearPendingSeek, commitCurrentTime }, nextTime)) return;
      refs.listenerIntentInstanceRef.current = refs.currentPlaybackInstanceKeyRef.current;
    },
    [clearPendingSeek, commitCurrentTime, duration, refs],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const audio = refs.audioRef.current;
      if (!audio) return;
      seekTo(audio.currentTime + seconds);
    },
    [refs, seekTo],
  );

  const seekBackward = useCallback(() => seekBy(-seekPreferencesRef.current.seekBackwardSeconds), [seekBy]);
  const seekForward = useCallback(() => seekBy(seekPreferencesRef.current.seekForwardSeconds), [seekBy]);

  return { seekTo, seekBy, seekBackward, seekForward };
}

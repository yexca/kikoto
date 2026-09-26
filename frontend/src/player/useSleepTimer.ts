import { useCallback, useEffect, useRef, useState } from "react";

import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import type { SleepTimerState } from "./playerTypes";
import {
  getStoredSleepRewindMinutes,
  planSleepStop,
  SLEEP_REWIND_CHANGE_EVENT,
  sleepRewindStorageKey,
  storeSleepRewindMinutes,
  type SleepRewindChangeDetail,
} from "./sleepRewind";
import type { PlaybackEngine } from "./usePlaybackEngine";
import { seekMediaElement } from "./usePlayerSeeking";

/** The account's sleep rewind minutes, kept in sync with other players and tabs. */
export function useSleepRewindPreference(principalID: ClientPrincipalID) {
  const storageKey = sleepRewindStorageKey(principalID);
  const [sleepRewindMinutes, setSleepRewindMinutesState] = useState(() => getStoredSleepRewindMinutes(principalID));

  useEffect(() => {
    setSleepRewindMinutesState(getStoredSleepRewindMinutes(principalID));
    const syncCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<SleepRewindChangeDetail>).detail;
      if (!detail || detail.storageKey !== storageKey) return;
      setSleepRewindMinutesState(detail.minutes);
    };
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setSleepRewindMinutesState(getStoredSleepRewindMinutes(principalID));
    };
    window.addEventListener(SLEEP_REWIND_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(SLEEP_REWIND_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, [principalID, storageKey]);

  const setSleepRewindMinutes = useCallback(
    (minutes: number) => setSleepRewindMinutesState(storeSleepRewindMinutes(principalID, minutes)),
    [principalID],
  );

  return { sleepRewindMinutes, setSleepRewindMinutes };
}

/**
 * The sleep timer: counts down to its deadline, optionally waits for the
 * current track to finish, and fades the volume out over the last ten seconds.
 * When it stops playback, the current track rests at the rewound position.
 */
export function useSleepTimer({
  initialSleepTimer,
  engine,
  rewindMinutes,
  checkpointProgress,
}: {
  initialSleepTimer: SleepTimerState;
  engine: PlaybackEngine;
  rewindMinutes: number;
  /** Forces a Resume cursor save for the current item when it runs. */
  checkpointProgress: (completed: boolean) => void;
}) {
  const {
    refs,
    currentTime,
    duration,
    updatePlayingState,
    invalidatePlaybackRequests,
    clearPendingSeek,
    commitCurrentTime,
  } = engine;
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(initialSleepTimer);
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState(0);
  // Read when the timer fires so changing the preference does not restart the countdown.
  const rewindMinutesRef = useRef(rewindMinutes);
  rewindMinutesRef.current = rewindMinutes;

  // Stops for the sleep timer and rests the current track at the rewound
  // position. `ended` is the finish-current-track timer at the end of a track,
  // which stops before the queue can advance. Everything is read from the
  // engine refs, so a timer that outlives track changes acts on the current one.
  const stopForSleepTimer = useCallback(
    (ended: boolean) => {
      const audio = refs.audioRef.current;
      const instanceKey = refs.currentPlaybackInstanceKeyRef.current;
      const unappliedStart = refs.unappliedStartRef.current;
      const pendingStart = refs.pendingPlaybackStartRef.current;
      const pendingStartMatches =
        pendingStart !== null && pendingStart.queueItemId === refs.currentTrackRef.current?.queueItemId;
      const startNotApplied =
        instanceKey !== null && refs.restoredMediaItemRef.current !== instanceKey
          ? pendingStartMatches
            ? pendingStart.positionSeconds
            : unappliedStart?.instanceKey === instanceKey
              ? unappliedStart.positionSeconds
              : null
          : null;
      const plan = planSleepStop({
        rewindMinutes: rewindMinutesRef.current,
        wasPlaying: ended || refs.isPlayingRef.current,
        unappliedStartSeconds: startNotApplied,
        pendingSeekSeconds: refs.pendingSeekTargetRef.current,
        elementPositionSeconds: audio?.currentTime ?? 0,
        ended,
        durationSeconds: audio?.duration ?? 0,
      });
      // Silence the element before moving it, so the rewound position is never
      // heard and a pending play request cannot resume it afterwards.
      updatePlayingState(false);
      invalidatePlaybackRequests();
      audio?.pause();
      if (plan.kind === "start" && instanceKey) {
        // Nothing was heard from this position yet; move where the pending start
        // will land without writing a cursor for an element that is still loading.
        if (pendingStartMatches) {
          refs.pendingPlaybackStartRef.current = { ...pendingStart, positionSeconds: plan.positionSeconds };
        }
        if (unappliedStart?.instanceKey === instanceKey) {
          refs.unappliedStartRef.current = { instanceKey, positionSeconds: plan.positionSeconds };
        }
      } else if (
        plan.kind === "seek" &&
        seekMediaElement({ refs, clearPendingSeek, commitCurrentTime }, plan.positionSeconds)
      ) {
        checkpointProgress(false);
      } else if (ended) {
        refs.completedPlaybackInstanceRef.current = instanceKey;
        checkpointProgress(true);
      } else {
        checkpointProgress(false);
      }
      setSleepTimer(null);
    },
    [checkpointProgress, clearPendingSeek, commitCurrentTime, invalidatePlaybackRequests, refs, updatePlayingState],
  );

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio) return;
    const deadlineFade =
      sleepTimer && !sleepTimer.waitingForTrackEnd && sleepRemainingSeconds > 0 && sleepRemainingSeconds <= 10
        ? Math.max(0, sleepRemainingSeconds / 10)
        : 1;
    const trackRemaining = Math.max(0, duration - currentTime);
    const trackEndFade =
      sleepTimer?.waitingForTrackEnd && duration > 0 && trackRemaining <= 10 ? trackRemaining / 10 : 1;
    audio.volume = Math.max(0, Math.min(1, Math.min(deadlineFade, trackEndFade)));
  }, [refs, sleepTimer, sleepRemainingSeconds, currentTime, duration]);

  useEffect(() => {
    if (!sleepTimer) {
      setSleepRemainingSeconds(0);
      return;
    }
    const checkDeadline = () => {
      if (sleepTimer.waitingForTrackEnd) {
        setSleepRemainingSeconds(0);
        return;
      }
      const remaining = Math.max(0, Math.ceil((sleepTimer.deadline - Date.now()) / 1000));
      setSleepRemainingSeconds(remaining);
      if (remaining > 0) return;
      const audio = refs.audioRef.current;
      if (
        sleepTimer.finishCurrentTrack &&
        audio &&
        !audio.paused &&
        !audio.ended &&
        Number.isFinite(audio.duration) &&
        audio.duration > 0 &&
        audio.currentTime < audio.duration - 0.25
      ) {
        setSleepTimer((current) => (current ? { ...current, waitingForTrackEnd: true } : null));
        return;
      }
      stopForSleepTimer(false);
    };
    checkDeadline();
    const interval = window.setInterval(checkDeadline, 1000);
    document.addEventListener("visibilitychange", checkDeadline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkDeadline);
    };
  }, [refs, sleepTimer, stopForSleepTimer]);

  const setSleepTimerMinutes = useCallback(
    (minutes: number, finishCurrentTrack: boolean) =>
      setSleepTimer({
        mode: "deadline",
        deadline: Date.now() + Math.max(1, minutes) * 60_000,
        finishCurrentTrack,
        waitingForTrackEnd: false,
      }),
    [],
  );
  const setSleepFinishCurrentTrack = useCallback(
    (enabled: boolean) => setSleepTimer((current) => (current ? { ...current, finishCurrentTrack: enabled } : null)),
    [],
  );
  const clearSleepTimer = useCallback(() => setSleepTimer(null), []);

  return {
    sleepTimer,
    sleepRemainingSeconds,
    setSleepTimerMinutes,
    setSleepFinishCurrentTrack,
    clearSleepTimer,
    stopForSleepTimer,
  };
}

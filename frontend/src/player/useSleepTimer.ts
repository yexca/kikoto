import { useCallback, useEffect, useState, type RefObject } from "react";

import type { SleepTimerState } from "./playerTypes";

/**
 * The sleep timer: counts down to its deadline, optionally waits for the
 * current track to finish, and fades the volume out over the last ten seconds.
 */
export function useSleepTimer({
  initialSleepTimer,
  audioRef,
  currentTime,
  duration,
  updatePlayingState,
  flushProgress,
}: {
  initialSleepTimer: SleepTimerState;
  audioRef: RefObject<HTMLAudioElement | null>;
  currentTime: number;
  duration: number;
  updatePlayingState: (playing: boolean) => void;
  flushProgress: () => void;
}) {
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(initialSleepTimer);
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const deadlineFade =
      sleepTimer && !sleepTimer.waitingForTrackEnd && sleepRemainingSeconds > 0 && sleepRemainingSeconds <= 10
        ? Math.max(0, sleepRemainingSeconds / 10)
        : 1;
    const trackRemaining = Math.max(0, duration - currentTime);
    const trackEndFade =
      sleepTimer?.waitingForTrackEnd && duration > 0 && trackRemaining <= 10 ? trackRemaining / 10 : 1;
    audio.volume = Math.max(0, Math.min(1, Math.min(deadlineFade, trackEndFade)));
  }, [audioRef, sleepTimer, sleepRemainingSeconds, currentTime, duration]);

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
      const audio = audioRef.current;
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
      // This effect outlives track changes; only the latest save knows the current track.
      flushProgress();
      updatePlayingState(false);
      setSleepTimer(null);
    };
    checkDeadline();
    const interval = window.setInterval(checkDeadline, 1000);
    document.addEventListener("visibilitychange", checkDeadline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkDeadline);
    };
  }, [audioRef, flushProgress, sleepTimer, updatePlayingState]);

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

  return { sleepTimer, sleepRemainingSeconds, setSleepTimerMinutes, setSleepFinishCurrentTrack, clearSleepTimer };
}

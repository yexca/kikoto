import type { AudioHTMLAttributes, Dispatch, SetStateAction } from "react";

import { shouldCheckpointPause } from "./playbackStart";
import { shouldCommitPlayerTime } from "./playerProgress";
import type { PlayMode, SleepTimerState } from "./playerTypes";
import type { PlaybackEngine } from "./usePlaybackEngine";

function knownDuration(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Event handlers for the player's audio element. They reconcile what the
 * element reports with the play intent: buffering, the sampled clock, duration,
 * progress checkpoints, and advancing when a track ends.
 */
export function audioElementEventProps(
  engine: PlaybackEngine,
  {
    queueLength,
    currentIndex,
    setCurrentIndex,
    mode,
    sleepTimer,
    stopForSleepTimer,
    saveProgress,
    onError,
  }: {
    queueLength: number;
    currentIndex: number;
    setCurrentIndex: Dispatch<SetStateAction<number>>;
    mode: PlayMode;
    sleepTimer: SleepTimerState;
    /** Stops for the sleep timer; `ended` stops at the end of the track without advancing. */
    stopForSleepTimer: (ended: boolean) => void;
    saveProgress: (completed: boolean, force?: boolean) => void;
    onError: () => void;
  },
): AudioHTMLAttributes<HTMLAudioElement> {
  const {
    refs,
    currentPlaybackInstanceKey,
    currentTime,
    setCurrentTime,
    commitCurrentTime,
    setDuration,
    setIsBuffering,
    clearPendingSeek,
    requestAudioPlay,
    updatePlayingState,
  } = engine;

  const handleEnded = () => {
    const audio = refs.audioRef.current;
    setIsBuffering(false);
    if (sleepTimer?.waitingForTrackEnd) {
      // The sleep timer decides whether the track rests rewound or completed.
      stopForSleepTimer(true);
      return;
    }
    refs.completedPlaybackInstanceRef.current = currentPlaybackInstanceKey;
    saveProgress(true, true);
    if (mode === "single" && audio) {
      audio.currentTime = 0;
      refs.sourceLoadingRef.current = false;
      updatePlayingState(true);
      requestAudioPlay(audio, currentPlaybackInstanceKey);
      return;
    }
    if (currentIndex < queueLength - 1) {
      setCurrentIndex((index) => index + 1);
      updatePlayingState(true);
      return;
    }
    if (mode === "loop" && queueLength > 0) {
      setCurrentIndex(0);
      updatePlayingState(true);
      return;
    }
    updatePlayingState(false);
  };

  return {
    onLoadStart: () => setIsBuffering(true),
    onWaiting: () => setIsBuffering(true),
    onCanPlay: () => setIsBuffering(false),
    onPlaying: () => {
      setIsBuffering(false);
      if (refs.isPlayingRef.current) refs.listenerIntentInstanceRef.current = currentPlaybackInstanceKey;
    },
    onEmptied: () => setIsBuffering(false),
    onTimeUpdate: (event) => {
      const now = performance.now();
      const nextTime = event.currentTarget.currentTime;
      const pendingSeekTarget = refs.pendingSeekTargetRef.current;
      if (pendingSeekTarget !== null) {
        if (Math.abs(nextTime - pendingSeekTarget) > 0.5) return;
        clearPendingSeek();
      }
      const jumped = Math.abs(nextTime - currentTime) >= 1;
      if (shouldCommitPlayerTime(refs.lastPlayerTimeCommitRef.current, now, jumped)) {
        refs.lastPlayerTimeCommitRef.current = now;
        setCurrentTime(nextTime);
      }
      saveProgress(false);
    },
    onLoadedMetadata: (event) => {
      const mediaDuration = event.currentTarget.duration;
      setDuration(
        knownDuration(mediaDuration) ?? knownDuration(refs.currentTrackRef.current?.durationSeconds ?? null) ?? 0,
      );
    },
    onDurationChange: (event) => {
      const mediaDuration = knownDuration(event.currentTarget.duration);
      const fallback = knownDuration(refs.currentTrackRef.current?.durationSeconds ?? null);
      if (mediaDuration !== null) setDuration(mediaDuration);
      else if (fallback !== null) setDuration(fallback);
    },
    onPlay: () => {
      if (!refs.isPlayingRef.current) {
        refs.audioRef.current?.pause();
        return;
      }
      refs.sourceLoadingRef.current = false;
      refs.completedPlaybackInstanceRef.current = null;
      updatePlayingState(true);
    },
    onPause: () => {
      if (refs.sourceLoadingRef.current) return;
      const audio = refs.audioRef.current;
      // The player's own pauses follow a paused intent. A pause while playback
      // is intended comes from outside, such as a headphone disconnect or a
      // system interruption, and becomes the listener's pause; the pause that
      // precedes `ended`, and one already undone by a newer play request, are not.
      if (refs.isPlayingRef.current && (!audio || audio.ended || !audio.paused)) return;
      if (audio) commitCurrentTime(audio.currentTime);
      if (shouldCheckpointPause(refs.completedPlaybackInstanceRef.current, currentPlaybackInstanceKey)) {
        saveProgress(false, true);
      }
      updatePlayingState(false);
    },
    onSeeked: (event) => {
      const nextTime = event.currentTarget.currentTime;
      const pendingSeekTarget = refs.pendingSeekTargetRef.current;
      if (pendingSeekTarget !== null && Math.abs(nextTime - pendingSeekTarget) > 0.5) return;
      clearPendingSeek();
      commitCurrentTime(nextTime);
      refs.nativeMediaSyncRef.current();
      saveProgress(false, true);
    },
    onEnded: handleEnded,
    onError,
  };
}

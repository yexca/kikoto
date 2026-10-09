import { useCallback, useEffect, useState } from "react";

import { isActivePlaybackRequest } from "./playbackRequest";
import { normalizePlaybackStartPosition } from "./playbackStart";
import { playbackInstanceKey, trackPlaybackKey } from "./playerTrackMedia";
import type { PlayerTrack } from "./playerTypes";

export type PendingPlaybackStart = {
  queueItemId: string;
  positionSeconds: number;
};

type PlayingStateUpdate = boolean | ((current: boolean) => boolean);

function createPlaybackRefs() {
  return {
    audioRef: { current: null as HTMLAudioElement | null },
    queueRef: { current: [] as PlayerTrack[] },
    currentIndexRef: { current: 0 },
    currentTrackRef: { current: null as PlayerTrack | null },
    isPlayingRef: { current: false },
    playbackGenerationRef: { current: 0 },
    currentPlaybackInstanceKeyRef: { current: null as string | null },
    compatibilityPlaybackEnabledRef: { current: false },
    sourceLoadingRef: { current: false },
    // The playback instance whose start position has been applied.
    restoredMediaItemRef: { current: null as string | null },
    pendingPlaybackStartRef: { current: null as PendingPlaybackStart | null },
    unappliedStartRef: { current: null as { instanceKey: string; positionSeconds: number } | null },
    listenerIntentInstanceRef: { current: null as string | null },
    completedPlaybackInstanceRef: { current: null as string | null },
    lastPlayerTimeCommitRef: { current: null as number | null },
    pendingSeekTargetRef: { current: null as number | null },
    pendingSeekTimerRef: { current: null as number | null },
    playbackErrorSequenceRef: { current: 0 },
    playbackErrorAbortRef: { current: null as AbortController | null },
    playbackErrorHandlerRef: { current: () => {} },
    nativeMediaSyncRef: { current: () => {} },
    /** Asked before a paused player starts; false holds the start, such as one that would use the speaker. */
    playbackStartGuardRef: { current: (): boolean => true },
  };
}

/**
 * Mutable playback bookkeeping shared by the player hooks. The object identity
 * never changes; handlers and effects read the fields when they run, so these
 * values never drive rendering.
 */
export type PlaybackRefs = ReturnType<typeof createPlaybackRefs>;

function isExpectedPlaybackInterruption(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return error.name === "AbortError" || error.name === "NotAllowedError";
}

/**
 * Owns the audio element's observable state (play intent, buffering, clock,
 * duration) and the request bookkeeping that keeps stale play() results and
 * start positions from applying to a newer source.
 */
export function usePlaybackEngine(queue: PlayerTrack[], currentIndex: number) {
  const [refs] = useState(createPlaybackRefs);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackReloadToken, setPlaybackReloadToken] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [durationLocationId, setDurationLocationId] = useState<number | null>(null);
  const [startPositionRequest, setStartPositionRequest] = useState(0);

  const currentTrack = queue[currentIndex] ?? null;
  const currentPlaybackKey = trackPlaybackKey(currentTrack);
  const currentPlaybackInstanceKey = playbackInstanceKey(currentTrack, playbackReloadToken);
  refs.isPlayingRef.current = isPlaying;
  refs.queueRef.current = queue;
  refs.currentIndexRef.current = currentIndex;
  refs.currentTrackRef.current = currentTrack;
  refs.currentPlaybackInstanceKeyRef.current = currentPlaybackInstanceKey;

  const cancelPlaybackErrorCheck = useCallback(() => {
    refs.playbackErrorAbortRef.current?.abort();
    refs.playbackErrorAbortRef.current = null;
    refs.playbackErrorSequenceRef.current += 1;
  }, [refs]);

  const updatePlayingState = useCallback(
    (next: PlayingStateUpdate) => {
      const resolved = typeof next === "function" ? next(refs.isPlayingRef.current) : next;
      if (resolved && !refs.isPlayingRef.current && !refs.playbackStartGuardRef.current()) return;
      if (resolved) cancelPlaybackErrorCheck();
      refs.isPlayingRef.current = resolved;
      setIsPlaying(resolved);
    },
    [cancelPlaybackErrorCheck, refs],
  );

  const invalidatePlaybackRequests = useCallback(() => {
    refs.playbackGenerationRef.current += 1;
  }, [refs]);

  const clearPendingSeek = useCallback(() => {
    refs.pendingSeekTargetRef.current = null;
    if (refs.pendingSeekTimerRef.current !== null) window.clearTimeout(refs.pendingSeekTimerRef.current);
    refs.pendingSeekTimerRef.current = null;
  }, [refs]);

  const commitCurrentTime = useCallback(
    (time: number) => {
      refs.lastPlayerTimeCommitRef.current = performance.now();
      setCurrentTime(time);
    },
    [refs],
  );

  // A start position still waiting for metadata is the instance's real position.
  const carriedPlaybackPosition = useCallback(() => {
    const unappliedStart = refs.unappliedStartRef.current;
    if (unappliedStart && unappliedStart.instanceKey === refs.currentPlaybackInstanceKeyRef.current) {
      return unappliedStart.positionSeconds;
    }
    return normalizePlaybackStartPosition(refs.audioRef.current?.currentTime);
  }, [refs]);

  const requestAudioPlay = useCallback(
    (audio: HTMLAudioElement, playbackKey: string | null) => {
      const generation = refs.playbackGenerationRef.current + 1;
      refs.playbackGenerationRef.current = generation;
      const request = { generation, playbackKey };
      const isActive = () =>
        isActivePlaybackRequest(
          request,
          refs.playbackGenerationRef.current,
          refs.currentPlaybackInstanceKeyRef.current,
          refs.isPlayingRef.current,
        );
      const handleFailure = (error: unknown) => {
        if (!isActive()) return;
        refs.sourceLoadingRef.current = false;
        setIsBuffering(false);
        updatePlayingState(false);
        if (!isExpectedPlaybackInterruption(error)) refs.playbackErrorHandlerRef.current();
      };
      let result: Promise<void> | void;
      try {
        result = audio.play();
      } catch (error) {
        handleFailure(error);
        return;
      }
      void Promise.resolve(result).then(() => {
        if (isActive()) refs.sourceLoadingRef.current = false;
      }, handleFailure);
    },
    [refs, updatePlayingState],
  );

  const requestStartPosition = useCallback(() => setStartPositionRequest((value) => value + 1), []);
  const reloadPlayback = useCallback(() => setPlaybackReloadToken((value) => value + 1), []);

  useEffect(() => () => clearPendingSeek(), [clearPendingSeek]);

  return {
    refs,
    currentTrack,
    currentPlaybackKey,
    currentPlaybackInstanceKey,
    isPlaying,
    isBuffering,
    setIsBuffering,
    currentTime,
    setCurrentTime,
    commitCurrentTime,
    duration,
    setDuration,
    durationLocationId,
    setDurationLocationId,
    startPositionRequest,
    requestStartPosition,
    reloadPlayback,
    updatePlayingState,
    invalidatePlaybackRequests,
    cancelPlaybackErrorCheck,
    clearPendingSeek,
    carriedPlaybackPosition,
    requestAudioPlay,
  };
}

export type PlaybackEngine = ReturnType<typeof usePlaybackEngine>;

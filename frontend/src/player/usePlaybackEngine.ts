import { useCallback, useEffect, useRef, useState } from "react";

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
    // An unloaded element that takes over playback when the player element is
    // replaced; rendered only while a replacement may be needed.
    standbyAudioRef: { current: null as HTMLAudioElement | null },
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
    // Returns false to hold a start; the guard owns any follow-up, such as a confirmation.
    playbackStartGuardRef: { current: (() => true) as () => boolean },
    // Runs when playback is requested, while the gesture that requested it still counts.
    playRequestRef: { current: () => {} },
    // The element volume is the product of these: the sleep timer's fade and
    // the loudness normalization cut, each from 0 to 1.
    sleepFadeRef: { current: 1 },
    loudnessVolumeRef: { current: 1 },
  };
}

/** Sets the element volume from the sleep fade and the loudness cut. */
export function applyElementVolume(refs: Pick<PlaybackRefs, "audioRef" | "sleepFadeRef" | "loudnessVolumeRef">) {
  const audio = refs.audioRef.current;
  if (!audio) return;
  audio.volume = Math.max(0, Math.min(1, refs.sleepFadeRef.current * refs.loudnessVolumeRef.current));
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
  // Changes when the player element is replaced; element-bound effects depend on it.
  const [audioElementKey, setAudioElementKey] = useState(0);

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
      const previous = refs.isPlayingRef.current;
      const resolved = typeof next === "function" ? next(previous) : next;
      if (resolved) cancelPlaybackErrorCheck();
      refs.isPlayingRef.current = resolved;
      setIsPlaying(resolved);
      if (resolved && !previous) refs.playRequestRef.current();
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
      if (!refs.playbackStartGuardRef.current()) {
        refs.sourceLoadingRef.current = false;
        setIsBuffering(false);
        updatePlayingState(false);
        return;
      }
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

  /**
   * Moves the current playback instance to the standby element at the same
   * position and play intent. The player element is replaced only when Web
   * Audio holds an element it can no longer use, since a new element has to
   * load the source again.
   */
  const replaceAudioElement = useCallback(() => {
    const instanceKey = refs.currentPlaybackInstanceKeyRef.current;
    if (instanceKey) refs.unappliedStartRef.current = { instanceKey, positionSeconds: carriedPlaybackPosition() };
    setAudioElementKey((value) => value + 1);
  }, [carriedPlaybackPosition, refs]);

  const attachedAudioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = refs.audioRef.current;
    const previous = attachedAudioRef.current;
    attachedAudioRef.current = audio;
    // A replaced element stops and releases its source.
    if (!previous || previous === audio) return;
    previous.pause();
    previous.removeAttribute("src");
    previous.load();
  }, [audioElementKey, refs]);

  useEffect(() => () => clearPendingSeek(), [clearPendingSeek]);

  return {
    refs,
    audioElementKey,
    replaceAudioElement,
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

import { useEffect, useMemo, useState } from "react";

import { assetURL } from "@/lib/api";

import { bufferedEndAt, shouldPreloadNextTrack } from "./nextTrackPreload";
import { playerTrackAudioURL } from "./playerTrackMedia";
import type { PlayerTrack } from "./playerTypes";
import type { PlaybackEngine } from "./usePlaybackEngine";
import { useNextTrackPreload } from "./useNextTrackPreload";

/**
 * Drives the audio element from player state: loads each playback instance,
 * applies its start position, follows the play/pause intent and playback rate,
 * and warms the next auto-advance track near the end of the current one.
 */
export function usePlaybackSource(
  engine: PlaybackEngine,
  {
    compatibilityPlaybackEnabled,
    playbackRate,
    nextTrack,
    nextTrackCompatibility,
  }: {
    compatibilityPlaybackEnabled: boolean;
    playbackRate: number;
    nextTrack: PlayerTrack | null;
    nextTrackCompatibility: boolean;
  },
) {
  const {
    refs,
    currentTrack,
    currentPlaybackInstanceKey,
    isPlaying,
    currentTime,
    setCurrentTime,
    duration,
    setDuration,
    durationLocationId,
    setDurationLocationId,
    startPositionRequest,
    cancelPlaybackErrorCheck,
    clearPendingSeek,
    invalidatePlaybackRequests,
    requestAudioPlay,
  } = engine;
  const currentLocationId = currentTrack?.locationId ?? null;
  const currentMediaItemId = currentTrack?.mediaItemId;
  const currentQueueItemId = currentTrack?.queueItemId;
  // Track objects are replaced by unrelated queue edits; the source string only
  // changes when the element really has to load something else.
  const currentSourceURL = useMemo(
    () => (currentTrack ? assetURL(playerTrackAudioURL(currentTrack, compatibilityPlaybackEnabled)) : null),
    [compatibilityPlaybackEnabled, currentTrack],
  );

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio) return;
    // Each load() resets playbackRate to defaultPlaybackRate, so both carry the choice across tracks.
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  }, [playbackRate, refs]);

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio) return;
    invalidatePlaybackRequests();
    cancelPlaybackErrorCheck();
    clearPendingSeek();
    if (currentSourceURL === null || currentLocationId === null) {
      refs.sourceLoadingRef.current = false;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setCurrentTime(0);
      setDuration(0);
      setDurationLocationId(null);
      return;
    }
    refs.sourceLoadingRef.current = true;
    audio.pause();
    audio.src = currentSourceURL;
    audio.load();
    refs.lastPlayerTimeCommitRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    setDurationLocationId(currentLocationId);
    refs.restoredMediaItemRef.current = null;
  }, [
    cancelPlaybackErrorCheck,
    clearPendingSeek,
    compatibilityPlaybackEnabled,
    currentLocationId,
    currentPlaybackInstanceKey,
    currentSourceURL,
    invalidatePlaybackRequests,
    refs,
    setCurrentTime,
    setDuration,
    setDurationLocationId,
  ]);

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio || !currentPlaybackInstanceKey || refs.restoredMediaItemRef.current === currentPlaybackInstanceKey)
      return;
    const pendingStart = refs.pendingPlaybackStartRef.current;
    const pendingStartMatches = pendingStart !== null && pendingStart.queueItemId === currentQueueItemId;
    const unappliedStart = refs.unappliedStartRef.current;
    const position = pendingStartMatches
      ? pendingStart.positionSeconds
      : unappliedStart?.instanceKey === currentPlaybackInstanceKey
        ? unappliedStart.positionSeconds
        : 0;
    if (pendingStartMatches) {
      refs.pendingPlaybackStartRef.current = null;
    }
    if (position > 0 && Number.isFinite(position)) {
      refs.unappliedStartRef.current = { instanceKey: currentPlaybackInstanceKey, positionSeconds: position };
      const restore = () => {
        audio.currentTime = Math.min(position, audio.duration || position);
        setCurrentTime(audio.currentTime);
        refs.unappliedStartRef.current = null;
        refs.restoredMediaItemRef.current = currentPlaybackInstanceKey;
      };
      if (audio.readyState >= 1) {
        restore();
      } else {
        audio.addEventListener("loadedmetadata", restore, { once: true });
        return () => audio.removeEventListener("loadedmetadata", restore);
      }
    } else {
      refs.unappliedStartRef.current = null;
      refs.restoredMediaItemRef.current = currentPlaybackInstanceKey;
    }
  }, [
    compatibilityPlaybackEnabled,
    currentLocationId,
    currentMediaItemId,
    currentPlaybackInstanceKey,
    currentQueueItemId,
    refs,
    setCurrentTime,
    startPositionRequest,
  ]);

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio || !currentTrack) return;
    if (isPlaying) {
      requestAudioPlay(audio, currentPlaybackInstanceKey);
    } else {
      refs.sourceLoadingRef.current = false;
      invalidatePlaybackRequests();
      audio.pause();
    }
  }, [
    compatibilityPlaybackEnabled,
    isPlaying,
    currentTrack,
    currentPlaybackInstanceKey,
    invalidatePlaybackRequests,
    refs,
    requestAudioPlay,
  ]);

  const [preloadArmedInstanceKey, setPreloadArmedInstanceKey] = useState<string | null>(null);
  const preloadArmed = currentPlaybackInstanceKey !== null && preloadArmedInstanceKey === currentPlaybackInstanceKey;

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio || currentLocationId === null || !currentPlaybackInstanceKey || preloadArmed) return;
    if (durationLocationId !== currentLocationId) return;
    if (shouldPreloadNextTrack({ playing: isPlaying, currentTime, duration, bufferedEnd: bufferedEndAt(audio) })) {
      setPreloadArmedInstanceKey(currentPlaybackInstanceKey);
    }
  }, [
    currentLocationId,
    currentPlaybackInstanceKey,
    currentTime,
    duration,
    durationLocationId,
    isPlaying,
    preloadArmed,
    refs,
  ]);

  const nextSourceURL = useMemo(
    () => (preloadArmed && nextTrack ? assetURL(playerTrackAudioURL(nextTrack, nextTrackCompatibility)) : null),
    [nextTrack, nextTrackCompatibility, preloadArmed],
  );
  useNextTrackPreload(nextSourceURL && nextSourceURL !== currentSourceURL ? nextSourceURL : null);
}

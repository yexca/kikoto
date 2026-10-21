import { useEffect, useMemo, useRef, useState } from "react";

import { assetURL } from "@/lib/api";

import { attachAudioHls } from "./audioHlsSource";
import { audioHlsPlayback } from "./mediaPlayback";
import { bufferedEndAt, nextTrackPreloadWindowSeconds, shouldPreloadNextTrack } from "./nextTrackPreload";
import { playerTrackAudioSource, type PlayerAudioSource } from "./playerTrackMedia";
import type { PlayerTrack } from "./playerTypes";
import type { PlaybackEngine } from "./usePlaybackEngine";
import { useNextTrackPreload } from "./useNextTrackPreload";

function assetSource(source: PlayerAudioSource): PlayerAudioSource {
  return { ...source, url: assetURL(source.url) };
}

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
    audioElementKey,
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
  // Track objects are replaced by unrelated queue edits; the source strings only
  // change when the element really has to load something else.
  const currentSource = useMemo(
    () => (currentTrack ? assetSource(playerTrackAudioSource(currentTrack, compatibilityPlaybackEnabled)) : null),
    [compatibilityPlaybackEnabled, currentTrack],
  );
  const currentSourceURL = currentSource?.url ?? null;
  const currentSourceIsHls = currentSource?.delivery === "hls";

  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio) return;
    // Each load() resets playbackRate to defaultPlaybackRate, so both carry the choice across tracks.
    audio.defaultPlaybackRate = playbackRate;
    audio.playbackRate = playbackRate;
  }, [audioElementKey, playbackRate, refs]);

  const loadedSourceRef = useRef<{
    audio: HTMLAudioElement;
    instanceKey: string | null;
    sourceURL: string;
  } | null>(null);
  useEffect(() => {
    const audio = refs.audioRef.current;
    if (!audio) return;
    invalidatePlaybackRequests();
    cancelPlaybackErrorCheck();
    clearPendingSeek();
    if (currentSourceURL === null || currentLocationId === null) {
      loadedSourceRef.current = null;
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
    const hlsPlayback = currentSourceIsHls ? audioHlsPlayback() : null;
    let detach = () => {};
    if (hlsPlayback) {
      const instanceKey = currentPlaybackInstanceKey;
      const current = () =>
        refs.audioRef.current === audio && refs.currentPlaybackInstanceKeyRef.current === instanceKey;
      detach = attachAudioHls(audio, currentSourceURL, hlsPlayback, {
        startPosition: () => {
          const unapplied = refs.unappliedStartRef.current;
          return unapplied && unapplied.instanceKey === instanceKey ? unapplied.positionSeconds : -1;
        },
        onAttached: () => {
          if (current() && refs.isPlayingRef.current) requestAudioPlay(audio, instanceKey);
        },
        onFatalError: () => {
          if (current()) refs.playbackErrorHandlerRef.current();
        },
      });
    } else {
      audio.src = currentSourceURL;
      audio.load();
    }
    refs.restoredMediaItemRef.current = null;
    // A replaced element loads the same instance again and resumes where the
    // previous element was, so the clock and duration stay.
    const loaded = loadedSourceRef.current;
    loadedSourceRef.current = { audio, instanceKey: currentPlaybackInstanceKey, sourceURL: currentSourceURL };
    if (!(
      loaded &&
      loaded.audio !== audio &&
      loaded.instanceKey === currentPlaybackInstanceKey &&
      loaded.sourceURL === currentSourceURL
    )) {
      refs.lastPlayerTimeCommitRef.current = null;
      setCurrentTime(0);
      setDuration(0);
      setDurationLocationId(currentLocationId);
    }
    return detach;
  }, [
    audioElementKey,
    cancelPlaybackErrorCheck,
    clearPendingSeek,
    compatibilityPlaybackEnabled,
    currentLocationId,
    currentPlaybackInstanceKey,
    currentSourceIsHls,
    currentSourceURL,
    invalidatePlaybackRequests,
    refs,
    requestAudioPlay,
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
    audioElementKey,
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
    audioElementKey,
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
    const windowSeconds = nextTrack
      ? nextTrackPreloadWindowSeconds(
          nextTrack.durationSeconds,
          playerTrackAudioSource(nextTrack, nextTrackCompatibility).delivery === "prepared",
        )
      : undefined;
    if (
      shouldPreloadNextTrack({
        playing: isPlaying,
        currentTime,
        duration,
        bufferedEnd: bufferedEndAt(audio),
        windowSeconds,
      })
    ) {
      setPreloadArmedInstanceKey(currentPlaybackInstanceKey);
    }
  }, [
    currentLocationId,
    currentPlaybackInstanceKey,
    currentTime,
    duration,
    durationLocationId,
    isPlaying,
    nextTrack,
    nextTrackCompatibility,
    preloadArmed,
    refs,
  ]);

  const nextSource = useMemo(
    () => (preloadArmed && nextTrack ? assetSource(playerTrackAudioSource(nextTrack, nextTrackCompatibility)) : null),
    [nextTrack, nextTrackCompatibility, preloadArmed],
  );
  useNextTrackPreload(nextSource && nextSource.url !== currentSourceURL ? nextSource : null);
}

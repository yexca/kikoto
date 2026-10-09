import { useCallback, useEffect, type RefObject } from "react";

import { assetURL } from "@/lib/api";
import { addNativeMediaListeners, stopNativeMedia, supportsNativeMedia, updateNativeMedia } from "@/lib/nativeMedia";
import { addNativeOutputLostListener } from "@/lib/nativePrivacy";

import type { PlaybackSeekPreferences } from "./playbackPreferences";
import { NATIVE_MEDIA_POSITION_INTERVAL_MS } from "./playerProgress";
import { bindMediaSessionActions, type PlayerRemoteControls } from "./playerRemoteControls";
import type { PlayerTrack } from "./playerTypes";
import { systemMediaDetails, useMediaSessionContent } from "./systemMediaPrivacy";
import type { PlaybackRefs } from "./usePlaybackEngine";

function absoluteAssetURL(path: string) {
  return new URL(assetURL(path), window.location.href).href;
}

/**
 * The Android media notification. Track and control changes update it
 * immediately; while playing, the position is recalibrated on an interval
 * instead of on every clock tick.
 */
export function useNativeMediaBridge({
  refs,
  controlsRef,
  currentTrack,
  isPlaying,
  duration,
  durationLocationId,
  playbackRate,
  canPrevious,
  canNext,
  seekPreferences,
}: {
  refs: PlaybackRefs;
  controlsRef: RefObject<PlayerRemoteControls>;
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  duration: number;
  durationLocationId: number | null;
  playbackRate: number;
  canPrevious: boolean;
  canNext: boolean;
  seekPreferences: PlaybackSeekPreferences;
}) {
  useEffect(() => {
    if (!supportsNativeMedia()) return;
    let removeListeners: (() => void) | null = null;
    let disposed = false;
    addNativeMediaListeners({
      onControl: (event) => {
        const controls = controlsRef.current;
        switch (event.command) {
          case "play":
            controls.play();
            break;
          case "pause":
            controls.pause();
            break;
          case "previous":
            controls.previous();
            break;
          case "next":
            controls.next();
            break;
          case "seekBackward":
            controls.seekBackward();
            break;
          case "seekForward":
            controls.seekForward();
            break;
          case "seekTo":
            controls.seekTo((event.positionMs ?? 0) / 1000);
            break;
        }
      },
    }).then((remove) => {
      if (disposed) {
        remove();
        return;
      }
      removeListeners = remove;
    });
    return () => {
      disposed = true;
      removeListeners?.();
    };
  }, [controlsRef]);

  const { seekBackwardSeconds, seekForwardSeconds } = seekPreferences;
  const syncNativeMedia = useCallback(() => {
    if (!supportsNativeMedia() || !currentTrack) return;
    const currentMediaDuration = durationLocationId === currentTrack.locationId ? duration : 0;
    const durationSeconds = [
      currentMediaDuration,
      currentTrack.durationSeconds,
      currentTrack.progress?.durationSeconds,
    ].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const durationMs = durationSeconds ? Math.floor(durationSeconds * 1000) : 0;
    const positionSeconds = refs.audioRef.current?.currentTime ?? 0;
    const positionMs = Math.min(Math.max(0, Math.floor(positionSeconds * 1000)), durationMs || Number.MAX_SAFE_INTEGER);
    void updateNativeMedia({
      title: currentTrack.title || currentTrack.workTitle || "Kikoto",
      artist: currentTrack.circle || currentTrack.workTitle || "Kikoto",
      album: currentTrack.workTitle || currentTrack.workCode || "Kikoto",
      coverUrl: currentTrack.coverUrl ? absoluteAssetURL(currentTrack.coverUrl) : "",
      playing: isPlaying,
      positionMs,
      durationMs,
      playbackRate,
      canPrevious,
      canNext,
      seekBackwardSeconds,
      seekForwardSeconds,
    });
  }, [
    canNext,
    canPrevious,
    currentTrack,
    duration,
    durationLocationId,
    isPlaying,
    playbackRate,
    refs,
    seekBackwardSeconds,
    seekForwardSeconds,
  ]);
  // Seeks report their new position without waiting for the next interval.
  refs.nativeMediaSyncRef.current = syncNativeMedia;

  useEffect(() => {
    if (!supportsNativeMedia()) return;
    if (!currentTrack) {
      void stopNativeMedia();
      return;
    }
    syncNativeMedia();
  }, [currentTrack, syncNativeMedia]);

  useEffect(() => {
    if (!supportsNativeMedia() || !currentTrack || !isPlaying) return;
    const interval = window.setInterval(syncNativeMedia, NATIVE_MEDIA_POSITION_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [currentTrack, isPlaying, syncNativeMedia]);

  useEffect(
    () => () => {
      void stopNativeMedia();
    },
    [],
  );
}

/**
 * The browser Media Session (lock screen, headset keys, OS media overlay),
 * also used by the iOS shell. A native build with its own media notification
 * owns these controls instead.
 */
export function useBrowserMediaSession({
  controlsRef,
  currentTrack,
  isPlaying,
  currentTime,
  duration,
  playbackRate,
}: {
  controlsRef: RefObject<PlayerRemoteControls>;
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
}) {
  const content = useMediaSessionContent();
  const details = currentTrack ? systemMediaDetails(currentTrack, content) : null;
  const title = details?.title ?? "";
  const artist = details?.artist ?? "";
  const album = details?.album ?? "";
  const coverUrl = details?.coverUrl ?? "";
  const hasTrack = details !== null;

  useEffect(() => {
    if (supportsNativeMedia() || !("mediaSession" in navigator)) return;
    return bindMediaSessionActions(navigator.mediaSession, () => controlsRef.current);
  }, [controlsRef]);

  // The iOS shell reports a lost audio output, such as disconnected
  // headphones, so playback pauses instead of moving to the speaker.
  useEffect(() => {
    let removeListener: (() => void) | null = null;
    let disposed = false;
    void addNativeOutputLostListener(() => controlsRef.current.pause()).then((remove) => {
      if (disposed) remove();
      else removeListener = remove;
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [controlsRef]);

  useEffect(() => {
    if (supportsNativeMedia() || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = hasTrack
      ? new MediaMetadata({
          title,
          artist,
          album,
          artwork: coverUrl ? [{ src: absoluteAssetURL(coverUrl) }] : [],
        })
      : null;
  }, [album, artist, coverUrl, hasTrack, title]);

  useEffect(() => {
    if (supportsNativeMedia() || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    if (duration > 0 && Number.isFinite(duration) && currentTime >= 0 && currentTime <= duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate,
          position: Math.min(currentTime, duration),
        });
      } catch {
        // Position state support varies across browsers.
      }
    }
  }, [isPlaying, currentTime, duration, playbackRate]);
}

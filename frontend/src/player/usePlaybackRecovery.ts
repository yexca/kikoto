import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";

import { useToast } from "@/components/ui/toast";
import { assetURL } from "@/lib/api";

import { playerTrackAudioURL, supportsCompatibilityPlayback } from "./playerTrackMedia";
import type { PlaybackCompatibilityScope, PlayerTrack } from "./playerTypes";
import {
  applyTrackLocation,
  createTrackLocationFailureState,
  recordTrackLocationFailure,
  resetTrackLocationFailures,
} from "./trackLocations";
import type { PlaybackEngine } from "./usePlaybackEngine";

/**
 * Handles a failed source: a missing file moves to the item's next location,
 * a local file the browser cannot decode offers compatibility playback, and a
 * track with no usable location stops with a retry action.
 */
export function usePlaybackRecovery(
  engine: PlaybackEngine,
  {
    setQueue,
    flushProgress,
    setPlaybackCompatibility,
  }: {
    setQueue: Dispatch<SetStateAction<PlayerTrack[]>>;
    flushProgress: () => void;
    setPlaybackCompatibility: (scope: PlaybackCompatibilityScope, resume?: boolean) => void;
  },
) {
  const { t } = useTranslation();
  const toast = useToast();
  const { refs, currentTrack, carriedPlaybackPosition, reloadPlayback, setIsBuffering, updatePlayingState } = engine;
  const [locationFailures] = useState(createTrackLocationFailureState);
  const currentQueueItemId = currentTrack?.queueItemId;
  const currentMediaItemId = currentTrack?.mediaItemId;

  const resetLocationFailures = useCallback(() => resetTrackLocationFailures(locationFailures), [locationFailures]);

  useEffect(() => {
    resetTrackLocationFailures(locationFailures);
  }, [currentMediaItemId, currentQueueItemId, locationFailures]);

  const switchAfterLocationFailure = useCallback(
    (failedTrack: PlayerTrack, instanceKey: string | null) => {
      if (!instanceKey || refs.currentPlaybackInstanceKeyRef.current !== instanceKey) return;
      const activeTrack = refs.currentTrackRef.current;
      if (!activeTrack || activeTrack.locationId !== failedTrack.locationId) return;
      const carryPosition = () => {
        if (!activeTrack.queueItemId) return;
        refs.pendingPlaybackStartRef.current = {
          queueItemId: activeTrack.queueItemId,
          positionSeconds: carriedPlaybackPosition(),
        };
      };
      const result = recordTrackLocationFailure(activeTrack, locationFailures);
      if (result.kind === "ignored") {
        refs.sourceLoadingRef.current = false;
        updatePlayingState(false);
        return;
      }
      if (result.kind === "terminal") {
        refs.sourceLoadingRef.current = false;
        updatePlayingState(false);
        const failureSequence = refs.playbackErrorSequenceRef.current;
        toast.notify({
          kind: "error",
          message: t("player.playbackFailed", { title: activeTrack.title }),
          actionLabel: t("common.retry"),
          onAction: () => {
            if (
              refs.currentPlaybackInstanceKeyRef.current !== instanceKey ||
              refs.playbackErrorSequenceRef.current !== failureSequence
            )
              return;
            resetTrackLocationFailures(locationFailures);
            carryPosition();
            reloadPlayback();
            updatePlayingState(true);
          },
        });
        return;
      }
      const nextLocation = result.location;
      flushProgress();
      carryPosition();
      refs.playbackGenerationRef.current += 1;
      refs.playbackErrorSequenceRef.current += 1;
      refs.sourceLoadingRef.current = true;
      setQueue((items) =>
        items.map((item, index) =>
          index === refs.currentIndexRef.current && item.locationId === activeTrack.locationId
            ? applyTrackLocation(item, nextLocation)
            : item,
        ),
      );
      updatePlayingState(true);
      toast.warning(
        t("player.sourceFailed", {
          source:
            nextLocation.sourceName ||
            t(`player.locationTypes.${nextLocation.locationType}`, { defaultValue: nextLocation.locationType }),
        }),
      );
    },
    [
      carriedPlaybackPosition,
      flushProgress,
      locationFailures,
      refs,
      reloadPlayback,
      setQueue,
      t,
      toast,
      updatePlayingState,
    ],
  );

  const handlePlaybackError = useCallback(() => {
    const failedTrack = refs.currentTrackRef.current;
    const instanceKey = refs.currentPlaybackInstanceKeyRef.current;
    const audio = refs.audioRef.current;
    if (!failedTrack || !instanceKey || !audio) return;
    const sequence = refs.playbackErrorSequenceRef.current;
    refs.playbackErrorAbortRef.current?.abort();
    const controller = new AbortController();
    refs.playbackErrorAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 3_000);
    const sourceURL =
      audio.currentSrc || assetURL(playerTrackAudioURL(failedTrack, refs.compatibilityPlaybackEnabledRef.current));
    refs.sourceLoadingRef.current = false;
    setIsBuffering(false);
    updatePlayingState(false);

    void (async () => {
      let status: number | null = null;
      let alreadyTranscoded = false;
      try {
        if (typeof fetch === "function") {
          const response = await fetch(sourceURL, {
            method: "HEAD",
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "*/*" },
            signal: controller.signal,
          });
          status = response.status;
          alreadyTranscoded = response.headers.get("X-Kikoto-Playback-Delivery") === "transcoded";
        }
      } catch {
        if (controller.signal.aborted && !timedOut) return;
      } finally {
        window.clearTimeout(timeout);
      }
      if (
        sequence !== refs.playbackErrorSequenceRef.current ||
        refs.currentPlaybackInstanceKeyRef.current !== instanceKey
      )
        return;
      refs.playbackErrorAbortRef.current = null;
      if (status === 404) {
        switchAfterLocationFailure(failedTrack, instanceKey);
        return;
      }
      if (
        supportsCompatibilityPlayback(failedTrack) &&
        !alreadyTranscoded &&
        !refs.compatibilityPlaybackEnabledRef.current
      ) {
        toast.notify({
          kind: "error",
          message: t("player.trackFailed", { title: failedTrack.title }),
          actionLabel: t("player.compatibility"),
          onAction: () => {
            if (refs.currentPlaybackInstanceKeyRef.current !== instanceKey) return;
            setPlaybackCompatibility("track", true);
          },
        });
        return;
      }
      switchAfterLocationFailure(failedTrack, instanceKey);
    })();
  }, [refs, setIsBuffering, setPlaybackCompatibility, switchAfterLocationFailure, t, toast, updatePlayingState]);

  // play() rejections reach the handler through the engine, which is created first.
  refs.playbackErrorHandlerRef.current = handlePlaybackError;

  return { handlePlaybackError, resetLocationFailures };
}

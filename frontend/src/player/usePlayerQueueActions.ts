import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { useToast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api } from "@/lib/api";

import type { LyricsChoice } from "./lyricsMatching";
import {
  applyLyricsChoiceToTrack,
  applyLyricsPreferenceOverride,
  lyricsPreferenceKey,
  lyricsPreferencePersists,
} from "./lyricsPreference";
import { normalizePlaybackStartPosition } from "./playbackStart";
import { withQueueIdentity } from "./playbackIdentity";
import type { LyricsPreferenceTarget, PlayerTrack, PlayMode } from "./playerTypes";
import { moveQueueItemToIndex, stepQueueIndex } from "./queueOrder";
import { applyTrackLocation } from "./trackLocations";
import type { PlaybackEngine } from "./usePlaybackEngine";

/**
 * Queue and lyrics-preference operations. Every operation keeps a stable
 * identity and reads the latest queue state, so a caller that registered one
 * earlier (a context consumer, a system media control) never acts on a stale
 * queue, index, or play mode.
 */
export function usePlayerQueueActions({
  engine,
  queue,
  setQueue,
  currentIndex,
  setCurrentIndex,
  mode,
  flushProgress,
  resetLocationFailures,
  resetTransientPlaybackCompatibility,
  clearSleepTimer,
}: {
  engine: PlaybackEngine;
  queue: PlayerTrack[];
  setQueue: Dispatch<SetStateAction<PlayerTrack[]>>;
  currentIndex: number;
  setCurrentIndex: Dispatch<SetStateAction<number>>;
  mode: PlayMode;
  flushProgress: () => void;
  resetLocationFailures: () => void;
  resetTransientPlaybackCompatibility: () => void;
  clearSleepTimer: () => void;
}) {
  const toast = useToast();
  const { refs, currentTrack, carriedPlaybackPosition, invalidatePlaybackRequests, updatePlayingState } = engine;
  const [lyricsPreferenceOverrides, setLyricsPreferenceOverrides] = useState<Record<string, number | null>>({});
  const lyricsPreferenceOverridesRef = useRef(lyricsPreferenceOverrides);
  lyricsPreferenceOverridesRef.current = lyricsPreferenceOverrides;

  const prepareTrack = (track: PlayerTrack) =>
    withQueueIdentity(applyLyricsPreferenceOverride(track, lyricsPreferenceOverridesRef.current));

  const playQueue = useStableCallback((tracks: PlayerTrack[], locationId: number, startPositionSeconds?: number) => {
    if (tracks.length === 0) return;
    resetTransientPlaybackCompatibility();
    invalidatePlaybackRequests();
    resetLocationFailures();
    flushProgress();
    const normalizedTracks = tracks.map(prepareTrack);
    const nextIndex = Math.max(
      0,
      normalizedTracks.findIndex((track) => track.locationId === locationId),
    );
    const startTrack = normalizedTracks[nextIndex];
    refs.pendingPlaybackStartRef.current = startTrack?.queueItemId
      ? {
          queueItemId: startTrack.queueItemId,
          positionSeconds: normalizePlaybackStartPosition(startPositionSeconds),
        }
      : null;
    setQueue(normalizedTracks);
    setCurrentIndex(nextIndex);
    updatePlayingState(true);
  });

  const selectTrack = useStableCallback((index: number) => {
    if (index < 0 || index >= queue.length) return;
    if (index !== currentIndex) {
      flushProgress();
      invalidatePlaybackRequests();
    }
    setCurrentIndex(index);
    updatePlayingState(true);
  });

  const step = (direction: -1 | 1) => {
    if (queue.length === 0) return;
    const nextIndex = stepQueueIndex(currentIndex, queue.length, mode, direction);
    if (nextIndex !== currentIndex) {
      flushProgress();
      invalidatePlaybackRequests();
    }
    setCurrentIndex(nextIndex);
    updatePlayingState(true);
  };
  const next = useStableCallback(() => step(1));
  const previous = useStableCallback(() => step(-1));

  const playNext = useStableCallback((track: PlayerTrack) => {
    const nextTrack = prepareTrack(track);
    setQueue((items) => {
      const nextItems = [...items];
      nextItems.splice(Math.min(items.length, currentIndex + 1), 0, nextTrack);
      return nextItems;
    });
  });

  const appendQueue = useStableCallback((tracks: PlayerTrack[]) => {
    if (tracks.length === 0) return;
    setQueue((items) => [...items, ...tracks.map(prepareTrack)]);
  });

  const moveQueueItemTo = useStableCallback((queueItemId: string, targetIndex: number) => {
    setQueue((items) => {
      const nextItems = moveQueueItemToIndex(items, queueItemId, targetIndex);
      if (nextItems === items) return items;
      const currentQueueItemId = items[currentIndex]?.queueItemId;
      if (currentQueueItemId) setCurrentIndex(nextItems.findIndex((item) => item.queueItemId === currentQueueItemId));
      return nextItems;
    });
  });

  const moveQueueItem = useStableCallback((queueItemId: string, direction: -1 | 1) => {
    const from = queue.findIndex((item) => item.queueItemId === queueItemId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= queue.length) return;
    moveQueueItemTo(queueItemId, to);
  });

  const removeQueueItem = useStableCallback((queueItemId: string) => {
    if (queue[currentIndex]?.queueItemId === queueItemId) {
      flushProgress();
      invalidatePlaybackRequests();
    }
    setQueue((items) => {
      const removedIndex = items.findIndex((item) => item.queueItemId === queueItemId);
      if (removedIndex < 0) return items;
      const removingCurrent = removedIndex === currentIndex;
      const nextItems = items.filter((item) => item.queueItemId !== queueItemId);
      if (nextItems.length === 0) {
        setCurrentIndex(0);
        updatePlayingState(false);
      } else if (removedIndex < currentIndex) {
        setCurrentIndex((index) => Math.max(0, index - 1));
      } else if (removingCurrent) {
        setCurrentIndex(Math.min(removedIndex, nextItems.length - 1));
      }
      return nextItems;
    });
  });

  const clearQueue = useStableCallback(() => {
    flushProgress();
    resetTransientPlaybackCompatibility();
    invalidatePlaybackRequests();
    setQueue([]);
    setCurrentIndex(0);
    updatePlayingState(false);
    clearSleepTimer();
  });

  const selectLocation = useStableCallback((locationId: number) => {
    if (currentTrack?.locationId !== locationId) {
      flushProgress();
      invalidatePlaybackRequests();
    }
    if (currentTrack?.queueItemId) {
      refs.pendingPlaybackStartRef.current = {
        queueItemId: currentTrack.queueItemId,
        positionSeconds: carriedPlaybackPosition(),
      };
    }
    resetLocationFailures();
    setQueue((items) =>
      items.map((item, index) => {
        if (index !== currentIndex) return item;
        const location = item.locations?.find((candidate) => candidate.locationId === locationId);
        return location ? applyTrackLocation(item, location) : item;
      }),
    );
  });

  const changeLyricsChoice = useCallback(
    async (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => {
      const preferenceKey = lyricsPreferenceKey(target);
      setLyricsPreferenceOverrides((current) => {
        const nextOverrides = { ...current, [preferenceKey]: choice?.mediaItemId ?? null };
        lyricsPreferenceOverridesRef.current = nextOverrides;
        return nextOverrides;
      });
      setQueue((items) =>
        items.map((item) =>
          lyricsPreferenceKey(item) === preferenceKey ? applyLyricsChoiceToTrack(item, target, choice) : item,
        ),
      );

      if (!lyricsPreferencePersists(target)) return;
      try {
        if (choice && choice.mediaItemId > 0) {
          await api.setMediaLyricsPreference(target.mediaItemId, choice.mediaItemId);
        } else {
          await api.clearMediaLyricsPreference(target.mediaItemId);
        }
      } catch (error) {
        toast.notify({
          kind: "warning",
          message:
            error instanceof Error
              ? error.message
              : choice
                ? "Lyrics preference could not be saved."
                : "Lyrics preference could not be cleared.",
        });
      }
    },
    [setQueue, toast],
  );

  return {
    lyricsPreferenceOverrides,
    changeLyricsChoice,
    playQueue,
    selectTrack,
    next,
    previous,
    playNext,
    appendQueue,
    moveQueueItemTo,
    moveQueueItem,
    removeQueueItem,
    clearQueue,
    selectLocation,
  };
}

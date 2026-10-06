import { useCallback, useEffect, useRef } from "react";

import { PLAYBACK_CURSOR_UPDATED_EVENT, type PlaybackCursorUpdatedDetail } from "@/lib/appEvents";
import { api, ApiError } from "@/lib/api";
import {
  currentClientStorageScope,
  isClientStorageScopeOnCurrentServer,
  type ClientPrincipalID,
} from "@/lib/clientStorageScope";

import { canPersistPlaybackProgress } from "./playbackStart";
import { shouldSaveRemoteProgress, type ProgressSaveMarker } from "./playerProgress";
import type { PlaybackEngine } from "./usePlaybackEngine";

type ProgressSavePayload = {
  locationId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
};

type ProgressSaveQueue = {
  inFlight: boolean;
  pending: Map<number, ProgressSavePayload>;
  controller: AbortController;
  isCurrent: () => boolean;
};

function waitForRetry(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, 200 + Math.round(Math.random() * 200));
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function saveProgressWithBusyRetry(
  mediaItemId: number,
  payload: ProgressSavePayload,
  principalID: ClientPrincipalID,
  queue: ProgressSaveQueue,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!queue.isCurrent()) return;
    try {
      const cursor = await api.updateMediaProgress(mediaItemId, payload, queue.controller.signal);
      if (!queue.isCurrent()) return;
      const detail: PlaybackCursorUpdatedDetail = { ...cursor, principalID };
      window.dispatchEvent(new CustomEvent(PLAYBACK_CURSOR_UPDATED_EVENT, { detail }));
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "database_busy" || attempt > 0) return;
      if (!queue.isCurrent()) return;
      await waitForRetry(queue.controller.signal);
    }
  }
}

/**
 * Saves the current item's Resume cursor. Saves are throttled, serialized, and
 * coalesced per media item; `flushProgress` forces a checkpoint for the item
 * that is current when it runs, and runs when the page is hidden or closed.
 */
export function usePlaybackProgress(engine: PlaybackEngine, canSaveRemotely: boolean, principalID: ClientPrincipalID) {
  const { refs, currentTrack, currentPlaybackInstanceKey, duration, durationLocationId } = engine;
  const scope = currentClientStorageScope(principalID);
  const currentScopeRef = useRef<string | null>(null);
  currentScopeRef.current = canSaveRemotely ? scope : null;
  const lastSavedRef = useRef<ProgressSaveMarker | null>(null);
  const saveQueueRef = useRef<ProgressSaveQueue | null>(null);
  const latestSaveRef = useRef<(completed: boolean, force?: boolean) => void>(() => {});

  useEffect(() => {
    lastSavedRef.current = null;
    if (!canSaveRemotely) return;
    const controller = new AbortController();
    const queue: ProgressSaveQueue = {
      inFlight: false,
      pending: new Map(),
      controller,
      isCurrent: () =>
        !controller.signal.aborted && currentScopeRef.current === scope && isClientStorageScopeOnCurrentServer(scope),
    };
    saveQueueRef.current = queue;
    return () => {
      // Requests use the session current when they start. Never drain or retry
      // this player's saves after an account/server change or unmount.
      controller.abort();
      queue.pending.clear();
      if (saveQueueRef.current === queue) saveQueueRef.current = null;
    };
  }, [canSaveRemotely, scope]);

  const queueProgressSave = (mediaItemId: number, payload: ProgressSavePayload) => {
    const queueState = saveQueueRef.current;
    if (!queueState?.isCurrent()) return;
    queueState.pending.set(mediaItemId, payload);
    if (queueState.inFlight) return;
    queueState.inFlight = true;
    void (async () => {
      while (queueState.isCurrent() && queueState.pending.size > 0) {
        const next = queueState.pending.entries().next().value;
        if (!next) break;
        queueState.pending.delete(next[0]);
        await saveProgressWithBusyRetry(next[0], next[1], principalID, queueState);
      }
      queueState.inFlight = false;
    })();
  };

  const saveProgress = (completed: boolean, force = false) => {
    const audio = refs.audioRef.current;
    if (!audio || !currentTrack) return;
    if (!currentTrack.progressRecordable) return;
    if (currentTrack.mediaItemId <= 0) return;
    // A save captured by an older render would pair this track's id with another track's audio position.
    if (currentPlaybackInstanceKey !== refs.currentPlaybackInstanceKeyRef.current) return;
    // An idle or still-loading element must not replace the persisted cursor with its own 0.
    if (
      !canPersistPlaybackProgress(
        currentPlaybackInstanceKey,
        refs.restoredMediaItemRef.current,
        refs.listenerIntentInstanceRef.current,
      )
    )
      return;
    const durationValue =
      [
        audio.duration,
        durationLocationId === currentTrack.locationId ? duration : null,
        currentTrack.durationSeconds,
        currentTrack.progress?.durationSeconds,
      ].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? null;
    const position = completed ? (durationValue ?? audio.currentTime) : audio.currentTime;
    if (!Number.isFinite(position) || position < 0) return;
    const marker = { mediaItemId: currentTrack.mediaItemId, position, completed, at: Date.now() };
    if (!canSaveRemotely) return;
    if (!shouldSaveRemoteProgress(lastSavedRef.current, marker, force)) return;
    lastSavedRef.current = marker;
    queueProgressSave(currentTrack.mediaItemId, {
      locationId: currentTrack.locationId,
      positionSeconds: position,
      durationSeconds: durationValue,
      completed,
    });
  };
  latestSaveRef.current = saveProgress;

  // Callers that outlive a render (timers, queue changes) must save the latest track, not their own.
  const flushProgress = useCallback(() => latestSaveRef.current(false, true), []);
  const checkpointProgress = useCallback((completed: boolean) => latestSaveRef.current(completed, true), []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushProgress();
    };
    window.addEventListener("pagehide", flushProgress);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushProgress);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [flushProgress]);

  return { saveProgress, flushProgress, checkpointProgress };
}

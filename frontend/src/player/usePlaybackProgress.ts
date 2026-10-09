import { useCallback, useEffect, useRef } from "react";
import { apiSessionForPrincipal } from "@/lib/apiSession";
import { currentClientStorageScope, type ClientPrincipalID } from "@/lib/clientStorageScope";

import { canPersistPlaybackProgress } from "./playbackStart";
import { useListeningSessionRecorder } from "./useListeningSessionRecorder";
import { usePlaybackReportScheduler } from "./usePlaybackReportScheduler";
import type { PlaybackEngine } from "./usePlaybackEngine";

/** Captures eligible Resume checkpoints locally. HTTP cadence belongs to the scheduler. */
export function usePlaybackProgress(engine: PlaybackEngine, canSaveRemotely: boolean, principalID: ClientPrincipalID) {
  const { refs, currentTrack, currentPlaybackInstanceKey, duration, durationLocationId } = engine;
  const scope = canSaveRemotely ? currentClientStorageScope(principalID) : null;
  const session = apiSessionForPrincipal(principalID);
  const schedulerRef = usePlaybackReportScheduler(scope, session, principalID);
  useListeningSessionRecorder(refs.audioRef, schedulerRef, scope, currentTrack, session);
  const latestSaveRef = useRef<(completed: boolean, force?: boolean) => void>(() => {});
  const lastStageRef = useRef(0);
  const lastInstanceRef = useRef<string | null>(null);

  const saveProgress = (completed: boolean, force = false) => {
    const audio = refs.audioRef.current;
    const scheduler = schedulerRef.current;
    if (!scheduler || !audio || !currentTrack || !currentTrack.progressRecordable || currentTrack.mediaItemId <= 0)
      return;
    if (currentPlaybackInstanceKey !== refs.currentPlaybackInstanceKeyRef.current) return;
    if (
      !canPersistPlaybackProgress(
        currentPlaybackInstanceKey,
        refs.restoredMediaItemRef.current,
        refs.listenerIntentInstanceRef.current,
      )
    )
      return;
    const now = performance.now();
    if (!force && lastInstanceRef.current === currentPlaybackInstanceKey && now - lastStageRef.current < 1000) return;
    const durationValue =
      [
        audio.duration,
        durationLocationId === currentTrack.locationId ? duration : null,
        currentTrack.durationSeconds,
        currentTrack.progress?.durationSeconds,
      ].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? null;
    const position = completed ? (durationValue ?? audio.currentTime) : audio.currentTime;
    if (!Number.isFinite(position) || position < 0) return;
    lastStageRef.current = now;
    lastInstanceRef.current = currentPlaybackInstanceKey;
    scheduler.stageProgress(currentTrack.workId, {
      mediaItemId: currentTrack.mediaItemId,
      locationId: currentTrack.locationId,
      positionSeconds: position,
      durationSeconds: durationValue,
      completed,
    });
    if (force) scheduler.requestFlush();
  };
  latestSaveRef.current = saveProgress;
  const flushProgress = useCallback(() => latestSaveRef.current(false, true), []);
  const checkpointProgress = useCallback((completed: boolean) => latestSaveRef.current(completed, true), []);

  useEffect(() => {
    const hide = () => {
      flushProgress();
      schedulerRef.current?.hide();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [flushProgress, schedulerRef]);
  return { saveProgress, flushProgress, checkpointProgress };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type RecordProgress } from "@/lib/api";
import { apiSessionForPrincipal } from "@/lib/apiSession";
import { currentClientStorageScope, type ClientPrincipalID } from "@/lib/clientStorageScope";

import { canPersistPlaybackProgress } from "./playbackStart";
import {
  RECORD_PROGRESS_SAVED_EVENT,
  RecordTrackProgressSaver,
  type RecordProgressSavedDetail,
} from "./recordTrackProgress";
import { useListeningSessionRecorder } from "./useListeningSessionRecorder";
import { usePlaybackReportScheduler } from "./usePlaybackReportScheduler";
import type { PlaybackEngine } from "./usePlaybackEngine";

function writeRecordProgress(assetId: number, progress: RecordProgress) {
  void api
    .updateRecordProgress(assetId, progress)
    .then(() => {
      const detail: RecordProgressSavedDetail = { assetId, progress };
      window.dispatchEvent(new CustomEvent(RECORD_PROGRESS_SAVED_EVENT, { detail }));
    })
    .catch(() => {
      // Progress is best effort; playback continues without it.
    });
}

/**
 * Captures eligible Resume checkpoints locally. HTTP cadence belongs to the
 * scheduler. A Record file saves its position to the Record library instead,
 * when the listener may write it, and never enters listening history.
 */
export function usePlaybackProgress(
  engine: PlaybackEngine,
  canSaveRemotely: boolean,
  canSaveRecordProgress: boolean,
  principalID: ClientPrincipalID,
) {
  const { refs, currentTrack, currentPlaybackInstanceKey, duration, durationLocationId, audioElementKey } = engine;
  const scope = canSaveRemotely ? currentClientStorageScope(principalID) : null;
  const session = apiSessionForPrincipal(principalID);
  const schedulerRef = usePlaybackReportScheduler(scope, session, principalID);
  useListeningSessionRecorder(refs.audioRef, schedulerRef, scope, currentTrack, session, audioElementKey);
  const latestSaveRef = useRef<(completed: boolean, force?: boolean) => void>(() => {});
  const lastStageRef = useRef(0);
  const lastInstanceRef = useRef<string | null>(null);
  const [recordSaver] = useState(() => new RecordTrackProgressSaver(writeRecordProgress));

  const saveProgress = (completed: boolean, force = false) => {
    const audio = refs.audioRef.current;
    const scheduler = schedulerRef.current;
    const record = currentTrack?.record;
    if (!audio || !currentTrack) return;
    if (
      record ? !canSaveRecordProgress : !scheduler || !currentTrack.progressRecordable || currentTrack.mediaItemId <= 0
    )
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
    if (record) {
      recordSaver.save(record.assetId, position, durationValue, completed, force);
      return;
    }
    if (!scheduler) return;
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

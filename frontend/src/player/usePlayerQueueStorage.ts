import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { api } from "@/lib/api";

import { restoredCursorStartPosition } from "./playbackStart";
import { discardObsoletePlayerState, loadPersistedQueue } from "./playerPersistence";
import { revalidatePersistedQueue } from "./playerQueueRestore";
import type { PlayerTrack, PlayMode, SleepTimerState } from "./playerTypes";
import type { PlaybackEngine } from "./usePlaybackEngine";

type RestoredPlayerQueue = ReturnType<typeof loadPersistedQueue>;

/** Reads the persisted queue once, before the first render uses it as initial state. */
export function useRestoredPlayerQueue(queueStorageKey: string, obsoleteProgressStorageKey: string) {
  const restoredRef = useRef<RestoredPlayerQueue | null>(null);
  if (restoredRef.current === null) {
    discardObsoletePlayerState(obsoleteProgressStorageKey);
    restoredRef.current = loadPersistedQueue(queueStorageKey);
  }

  useEffect(() => {
    discardObsoletePlayerState(obsoleteProgressStorageKey);
  }, [obsoleteProgressStorageKey]);

  return restoredRef.current;
}

/**
 * Refreshes a restored queue against the library once after startup. The result
 * is dropped if the listener already changed the queue, and the restored item
 * continues its Resume cursor unless the listener has already acted on it.
 */
export function useRestoredQueueRevalidation(
  restored: RestoredPlayerQueue,
  engine: PlaybackEngine,
  setQueue: Dispatch<SetStateAction<PlayerTrack[]>>,
  setCurrentIndex: Dispatch<SetStateAction<number>>,
) {
  const { refs, invalidatePlaybackRequests, requestStartPosition } = engine;

  // Every dependency is fixed for the provider's lifetime, so this runs once after startup.
  useEffect(() => {
    const restoredTracks = restored.queue;
    if (restoredTracks.length === 0) return;
    let cancelled = false;
    void revalidatePersistedQueue(
      restoredTracks,
      async (workID) => (await api.getWorkMedia(workID)).mediaItems,
      async (workID) => {
        const work = await api.getWorkSummary(workID);
        return {
          primaryCode: work.primaryCode,
          title: work.title,
          coverUrl: work.coverUrl,
          circle: work.circle,
        };
      },
    ).then((validated) => {
      if (cancelled) return;
      const current = refs.queueRef.current;
      if (
        current.length !== restoredTracks.length ||
        current.some((track, index) => track.queueItemId !== restoredTracks[index]?.queueItemId)
      )
        return;
      const currentQueueItemID = current[refs.currentIndexRef.current]?.queueItemId;
      const validatedIndex = Math.max(
        0,
        validated.findIndex((track) => track.queueItemId === currentQueueItemID),
      );
      // The restored session item continues its Resume cursor until the listener acts on it.
      const cursorPosition = restoredCursorStartPosition(validated[validatedIndex]?.progress);
      if (
        cursorPosition > 0 &&
        currentQueueItemID &&
        currentQueueItemID === restoredTracks[restored.currentIndex]?.queueItemId &&
        refs.listenerIntentInstanceRef.current !== refs.currentPlaybackInstanceKeyRef.current
      ) {
        refs.pendingPlaybackStartRef.current = { queueItemId: currentQueueItemID, positionSeconds: cursorPosition };
        refs.restoredMediaItemRef.current = null;
        requestStartPosition();
      }
      invalidatePlaybackRequests();
      setQueue(validated);
      setCurrentIndex(validatedIndex);
    });
    return () => {
      cancelled = true;
    };
  }, [invalidatePlaybackRequests, refs, requestStartPosition, restored, setCurrentIndex, setQueue]);
}

/** Persists the recordable part of the queue and the listener's playback choices. */
export function usePersistPlayerQueue({
  storageKey,
  queue,
  currentIndex,
  mode,
  playbackRate,
  sleepTimer,
}: {
  storageKey: string;
  queue: PlayerTrack[];
  currentIndex: number;
  mode: PlayMode;
  playbackRate: number;
  sleepTimer: SleepTimerState;
}) {
  useEffect(() => {
    const persistentQueue = queue
      .filter((track) => track.mediaItemId > 0 && track.progressRecordable)
      .map((track) => ({ ...track, progress: null }));
    const currentQueueItemId = queue[currentIndex]?.queueItemId ?? "";
    const persistedCurrentIndex = Math.max(
      0,
      persistentQueue.findIndex((track) => track.queueItemId === currentQueueItemId),
    );
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          queue: persistentQueue,
          currentIndex: persistedCurrentIndex,
          mode,
          playbackRate,
          sleepTimer,
        }),
      );
    } catch {
      // Playback should continue when browser storage is unavailable or full.
    }
  }, [queue, currentIndex, mode, playbackRate, storageKey, sleepTimer]);
}

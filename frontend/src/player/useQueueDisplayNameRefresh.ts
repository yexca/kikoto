import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import { api, type MediaItem } from "@/lib/api";
import { FILE_DISPLAY_NAMES_CHANGED_EVENT } from "@/lib/appEvents";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";

import type { PlayerTrack } from "./playerTypes";
import { withQueueDisplayTitles } from "./queueDisplayNames";

const concurrentWorkLoads = 4;

/**
 * Loads works' media for queued track names, a few works at a time, and hands
 * each finished batch to `apply`. A newer load for a work can start while an
 * older batch still waits on other works, so the older batch drops that work
 * when it is applied rather than when its media arrived. A work whose media
 * fails to load is left out, so its tracks keep their names.
 */
export function createQueueDisplayNameLoader(
  getWorkMedia: (workId: number) => Promise<MediaItem[]>,
  apply: (mediaByWork: Map<number, MediaItem[]>) => void,
) {
  let sequence = 0;
  const latestLoad = new Map<number, number>();
  return async (workIds: number[]) => {
    const pending = workIds.map((workId) => {
      sequence += 1;
      latestLoad.set(workId, sequence);
      return { workId, load: sequence };
    });
    const loaded = new Map<number, { load: number; mediaItems: MediaItem[] }>();
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrentWorkLoads, pending.length) }, async () => {
      while (cursor < pending.length) {
        const { workId, load } = pending[cursor++];
        try {
          loaded.set(workId, { load, mediaItems: await getWorkMedia(workId) });
        } catch {
          // The work keeps the names its tracks were queued with.
        }
      }
    });
    await Promise.all(workers);
    const media = new Map<number, MediaItem[]>();
    for (const [workId, { load, mediaItems }] of loaded) {
      if (latestLoad.get(workId) === load) media.set(workId, mediaItems);
    }
    if (media.size > 0) apply(media);
  };
}

/**
 * Keeps the names of queued tracks current while the queue plays: after the
 * listener changes a preference, such as the metadata language, every queued
 * work's names load again, and after a work's names are saved, that work's do.
 * Only the names change, so the current track keeps playing where it is.
 */
export function useQueueDisplayNameRefresh(
  queueRef: RefObject<PlayerTrack[]>,
  setQueue: Dispatch<SetStateAction<PlayerTrack[]>>,
) {
  useEffect(() => {
    let disposed = false;
    const refresh = createQueueDisplayNameLoader(
      async (workId) => (await api.getWorkMedia(workId)).mediaItems,
      (media) => {
        if (!disposed) setQueue((items) => withQueueDisplayTitles(items, media));
      },
    );

    const queuedWorkIds = () =>
      Array.from(new Set(queueRef.current.map((track) => track.workId).filter((workId) => workId > 0)));
    const preferencesChanged = () => void refresh(queuedWorkIds());
    const namesChanged = (event: Event) => {
      const workId = (event as CustomEvent<{ workId?: number }>).detail?.workId;
      if (workId && queuedWorkIds().includes(workId)) void refresh([workId]);
    };
    window.addEventListener(USER_PREFERENCES_CHANGED, preferencesChanged);
    window.addEventListener(FILE_DISPLAY_NAMES_CHANGED_EVENT, namesChanged);
    return () => {
      disposed = true;
      window.removeEventListener(USER_PREFERENCES_CHANGED, preferencesChanged);
      window.removeEventListener(FILE_DISPLAY_NAMES_CHANGED_EVENT, namesChanged);
    };
  }, [queueRef, setQueue]);
}

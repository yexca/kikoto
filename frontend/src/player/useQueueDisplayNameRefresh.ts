import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import { api, type MediaItem } from "@/lib/api";
import { FILE_DISPLAY_NAMES_CHANGED_EVENT } from "@/lib/appEvents";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";

import type { PlayerTrack } from "./playerTypes";
import { withQueueDisplayTitles } from "./queueDisplayNames";

const concurrentWorkLoads = 4;

/**
 * Keeps the names of queued tracks current while the queue plays: after the
 * listener changes a preference, such as the metadata language, every queued
 * work's names load again, and after a work's names are saved, that work's do.
 * Only the names change, so the current track keeps playing where it is. A
 * work whose media fails to load keeps its names, and a load that a newer one
 * for the same work overtook is dropped.
 */
export function useQueueDisplayNameRefresh(
  queueRef: RefObject<PlayerTrack[]>,
  setQueue: Dispatch<SetStateAction<PlayerTrack[]>>,
) {
  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    const latestLoad = new Map<number, number>();

    const refresh = async (workIds: number[]) => {
      const pending = workIds.map((workId) => {
        sequence += 1;
        latestLoad.set(workId, sequence);
        return { workId, load: sequence };
      });
      const media = new Map<number, MediaItem[]>();
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrentWorkLoads, pending.length) }, async () => {
        while (cursor < pending.length) {
          const { workId, load } = pending[cursor++];
          try {
            const { mediaItems } = await api.getWorkMedia(workId);
            if (latestLoad.get(workId) === load) media.set(workId, mediaItems);
          } catch {
            // The work keeps the names its tracks were queued with.
          }
        }
      });
      await Promise.all(workers);
      if (!disposed && media.size > 0) setQueue((items) => withQueueDisplayTitles(items, media));
    };

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

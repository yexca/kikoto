import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import { api } from "@/lib/api";
import { FILE_DISPLAY_NAMES_CHANGED_EVENT } from "@/lib/appEvents";
import { createEffectScope } from "@/lib/effectScope";
import { USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";

import { resolvableQueueTrack, resolveQueueTracks, type ResolvePlaybackQueue } from "./playerQueueRestore";
import type { PlayerTrack } from "./playerTypes";
import { queueDisplayTitleKey, withQueueDisplayTitles } from "./queueDisplayNames";

/**
 * Resolves the display names of queued tracks in one request and hands them
 * to `apply`. A newer load for a work can start while an older one still
 * waits, so the older load drops that work's names when it is applied. A
 * failed load, or an item that cannot play now, leaves the names as they are.
 */
export function createQueueDisplayNameLoader(
  resolve: ResolvePlaybackQueue,
  apply: (titles: Map<string, string | undefined>) => void,
) {
  let sequence = 0;
  const latestLoad = new Map<number, number>();
  return async (tracks: PlayerTrack[]) => {
    const queued = tracks.filter(resolvableQueueTrack);
    if (queued.length === 0) return;
    sequence += 1;
    const load = sequence;
    for (const track of queued) latestLoad.set(track.workId, load);
    let resolution: Awaited<ReturnType<typeof resolveQueueTracks>>;
    try {
      resolution = await resolveQueueTracks(queued, resolve, { titlesOnly: true });
    } catch {
      // The tracks keep the names they were queued with.
      return;
    }
    const titles = new Map<string, string | undefined>();
    resolution.resolved.forEach((item, index) => {
      const track = queued[index];
      if (item.status !== "playable" || !item.track || latestLoad.get(track.workId) !== load) return;
      titles.set(queueDisplayTitleKey(track), item.track.displayTitle);
    });
    if (titles.size > 0) apply(titles);
  };
}

/**
 * Keeps the names of queued tracks current while the queue plays: after the
 * listener changes a preference, such as the metadata language, the whole
 * queue's names resolve again in one request, and after a work's names are
 * saved, that work's do. Only the names change, so the current track keeps
 * playing where it is.
 */
export function useQueueDisplayNameRefresh(
  queueRef: RefObject<PlayerTrack[]>,
  setQueue: Dispatch<SetStateAction<PlayerTrack[]>>,
) {
  useEffect(() => {
    const scope = createEffectScope();
    const refresh = createQueueDisplayNameLoader(api.resolvePlaybackQueue, (titles) => {
      if (!scope.signal.aborted) setQueue((items) => withQueueDisplayTitles(items, titles));
    });

    const preferencesChanged = () => void refresh(queueRef.current);
    const namesChanged = (event: Event) => {
      const workId = (event as CustomEvent<{ workId?: number }>).detail?.workId;
      if (workId) void refresh(queueRef.current.filter((track) => track.workId === workId));
    };
    window.addEventListener(USER_PREFERENCES_CHANGED, preferencesChanged);
    window.addEventListener(FILE_DISPLAY_NAMES_CHANGED_EVENT, namesChanged);
    return () => {
      scope.cancel();
      window.removeEventListener(USER_PREFERENCES_CHANGED, preferencesChanged);
      window.removeEventListener(FILE_DISPLAY_NAMES_CHANGED_EVENT, namesChanged);
    };
  }, [queueRef, setQueue]);
}

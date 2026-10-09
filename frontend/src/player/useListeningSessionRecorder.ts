import { useEffect, useRef, type RefObject } from "react";

import { isMediaAdvancing, ListeningClock, type ListeningTarget } from "./listeningSession";
import type { PlaybackReportScheduler } from "./playbackReportScheduler";
import type { PlayerTrack } from "./playerTypes";
import { createReportId } from "./reportId";

const STATE_EVENTS = ["playing", "pause", "waiting", "seeking", "seeked", "canplay", "emptied", "error"] as const;

/** Media events measure and checkpoint locally; the scheduler alone sends. */
export function useListeningSessionRecorder(
  mediaRef: RefObject<HTMLMediaElement | null>,
  schedulerRef: RefObject<PlaybackReportScheduler | null>,
  scope: string | null,
  track: Pick<PlayerTrack, "queueItemId" | "workId"> | null,
  session: number | null,
) {
  const target: ListeningTarget | null =
    track?.queueItemId && track.workId > 0 ? { activationKey: track.queueItemId, workId: track.workId } : null;
  const targetRef = useRef(target);
  targetRef.current = target;
  const syncRef = useRef<() => void>(() => {});
  useEffect(() => {
    const media = mediaRef.current;
    const scheduler = schedulerRef.current;
    if (!media || !scheduler) return;
    const clock = new ListeningClock(createReportId, (report) => scheduler.stageHistory(report));
    const sync = () =>
      clock.update(targetRef.current, scheduler.generation, isMediaAdvancing(media), performance.now(), Date.now());
    const observe = () => {
      if (isMediaAdvancing(media)) clock.observe(performance.now(), Date.now());
      else sync();
    };
    const stateChange = () => {
      sync();
      if (!isMediaAdvancing(media)) scheduler.requestFlush();
    };
    const ended = () => {
      clock.observe(performance.now(), Date.now());
      clock.end();
      scheduler.requestFlush();
    };
    // Progress's page-hide listener stages the cursor after this clock snapshot,
    // then requests one keepalive batch containing both checkpoints.
    const hide = () => {
      observe();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
      else sync();
    };
    syncRef.current = sync;
    const unsubscribe = scheduler.subscribeGeneration(sync);
    sync();
    for (const name of STATE_EVENTS) media.addEventListener(name, stateChange);
    media.addEventListener("timeupdate", observe);
    media.addEventListener("ended", ended);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    // Local one-second checkpoints bound crash loss independently of HTTP cadence.
    const timer = window.setInterval(() => {
      observe();
      scheduler.tick();
    }, 1000);
    return () => {
      unsubscribe();
      for (const name of STATE_EVENTS) media.removeEventListener(name, stateChange);
      media.removeEventListener("timeupdate", observe);
      media.removeEventListener("ended", ended);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(timer);
      syncRef.current = () => {};
    };
  }, [mediaRef, schedulerRef, scope, session]);
  useEffect(() => {
    syncRef.current();
  }, [track?.queueItemId, track?.workId]);
}

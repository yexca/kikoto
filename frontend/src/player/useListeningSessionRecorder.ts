import { useEffect, useMemo, useRef, type RefObject } from "react";

import { ApiError } from "@/lib/api";
import { isClientStorageScopeOnCurrentServer } from "@/lib/clientStorageScope";
import { LISTENING_HISTORY_CLEARED_CODE, listeningApi } from "@/lib/listeningApi";
import { subscribeListeningHistoryCleared } from "@/lib/listeningHistoryEvents";

import {
  isMediaAdvancing,
  LISTENING_HEARTBEAT_MS,
  ListeningSessionTracker,
  type ListeningTarget,
} from "./listeningSession";
import type { PlayerTrack } from "./playerTypes";

function createSessionID() {
  const cryptoAPI: Crypto = globalThis.crypto;
  if (typeof cryptoAPI.randomUUID === "function") return cryptoAPI.randomUUID();
  // randomUUID needs a secure context; keep the UUID shape on a plain-HTTP LAN origin.
  const bytes = new Uint8Array(16);
  cryptoAPI.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPermanentRequestFailure(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.retryable || error.code === "database_busy") return false;
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

function isHistoryClearedFailure(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === LISTENING_HISTORY_CLEARED_CODE;
}

const MEDIA_STATE_EVENTS = ["playing", "pause", "waiting", "seeking", "seeked", "canplay", "emptied", "error"] as const;

/**
 * Records durable listening sessions for the global player's media element.
 * `scope` identifies the server and principal and is null when the viewer may
 * not record (anonymous, Demo, or without playback permission). Each queue item
 * activation is credited to its library work; an unresolved remote preview has
 * no work and is not recorded.
 */
export function useListeningSessionRecorder(
  mediaRef: RefObject<HTMLMediaElement | null>,
  scope: string | null,
  track: Pick<PlayerTrack, "queueItemId" | "workId"> | null,
) {
  const workId = track && track.workId > 0 ? track.workId : 0;
  const activationKey = track?.queueItemId ?? null;
  const target = useMemo<ListeningTarget | null>(
    () => (workId > 0 && activationKey ? { activationKey, workId } : null),
    [activationKey, workId],
  );
  const trackerRef = useRef<ListeningSessionTracker | null>(null);
  const stateRef = useRef({ scope, target });
  stateRef.current = { scope, target };

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    // Requests carry whatever credentials are configured when they start. The
    // tracker learns about a new principal or server one effect later, so a
    // request for any other scope is refused here rather than sent.
    const whileScopeIsCurrent = <T>(requestScope: string, request: () => Promise<T>) =>
      stateRef.current.scope === requestScope && isClientStorageScopeOnCurrentServer(requestScope)
        ? request()
        : Promise.reject(new Error("The listening scope is no longer current."));
    const tracker = new ListeningSessionTracker({
      send: (report, { keepalive, scope: requestScope }) =>
        whileScopeIsCurrent(requestScope, () => listeningApi.reportSession(report, { keepalive })),
      fetchGeneration: (requestScope) =>
        whileScopeIsCurrent(requestScope, () => listeningApi.generation().then((result) => result.generation)),
      createId: createSessionID,
      now: () => performance.now(),
      isPermanentFailure: isPermanentRequestFailure,
      isHistoryCleared: isHistoryClearedFailure,
    });
    trackerRef.current = tracker;
    const sync = () => {
      const { scope: currentScope, target: currentTarget } = stateRef.current;
      tracker.update(
        { scope: currentScope, target: currentTarget, advancing: isMediaAdvancing(media) },
        performance.now(),
      );
    };
    const observe = () => {
      if (isMediaAdvancing(media)) tracker.observe(performance.now());
      else sync();
    };
    const ended = () => tracker.endActivation(performance.now());
    const hide = () => {
      tracker.observe(performance.now());
      tracker.flush({ keepalive: true });
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    sync();
    for (const name of MEDIA_STATE_EVENTS) media.addEventListener(name, sync);
    media.addEventListener("timeupdate", observe);
    media.addEventListener("ended", ended);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    const interval = window.setInterval(() => tracker.heartbeat(performance.now()), LISTENING_HEARTBEAT_MS);
    return () => {
      for (const name of MEDIA_STATE_EVENTS) media.removeEventListener(name, sync);
      media.removeEventListener("timeupdate", observe);
      media.removeEventListener("ended", ended);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      window.clearInterval(interval);
      // Unmounting follows a server or principal change; never send the old
      // principal's remaining time with the next principal's credentials.
      tracker.dispose();
      if (trackerRef.current === tracker) trackerRef.current = null;
    };
  }, [mediaRef]);

  // A cleared history must not regain the time of sessions measured before it.
  useEffect(() => {
    if (!scope) return;
    return subscribeListeningHistoryCleared(scope, () => trackerRef.current?.discardHistory(performance.now()));
  }, [scope]);

  useEffect(() => {
    trackerRef.current?.update({ scope, target, advancing: isMediaAdvancing(mediaRef.current) }, performance.now());
  }, [mediaRef, scope, target]);
}

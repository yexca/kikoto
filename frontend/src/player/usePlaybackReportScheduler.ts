import { useEffect, useRef } from "react";
import { ApiError, apiTransport } from "@/lib/api";
import { apiSessionVersion } from "@/lib/apiSession";
import { PLAYBACK_CURSOR_UPDATED_EVENT } from "@/lib/appEvents";
import { isClientStorageScopeOnCurrentServer, type ClientPrincipalID } from "@/lib/clientStorageScope";
import { subscribeListeningHistoryCleared } from "@/lib/listeningHistoryEvents";
import { combineAbortSignals } from "@/lib/inflightRequests";
import { LISTENING_REPORT_TIMEOUT_MS } from "@/lib/listeningApi";
import { sendPlaybackReport } from "@/lib/playbackReportApi";

import { createReportOutbox } from "./playbackReportOutbox";
import { PlaybackReportScheduler } from "./playbackReportScheduler";
import { createReportId } from "./reportId";

function isPermanentFailure(error: unknown) {
  return (
    error instanceof ApiError &&
    !error.retryable &&
    error.code !== "database_busy" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

async function fetchGeneration(signal: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LISTENING_REPORT_TIMEOUT_MS);
  const cancellation = combineAbortSignals(signal, controller.signal);
  try {
    return (await apiTransport.getJSON<{ generation: number }>("/api/listening-sessions", cancellation.signal))
      .generation;
  } finally {
    clearTimeout(timer);
    cancellation.dispose();
  }
}

export function usePlaybackReportScheduler(
  scope: string | null,
  session: number | null,
  principalID: ClientPrincipalID,
) {
  const schedulerRef = useRef<PlaybackReportScheduler | null>(null);
  const currentRef = useRef({ scope, session });
  currentRef.current = { scope, session };
  useEffect(() => {
    if (!scope || session === null) return;
    let warned = false;
    const warn = () => {
      if (!warned) {
        warned = true;
        console.warn("Some playback reports could not be retained or accepted.");
      }
    };
    const scheduler = new PlaybackReportScheduler({
      outbox: createReportOutbox(scope, warn),
      now: Date.now,
      createId: createReportId,
      isCurrent: () =>
        currentRef.current.scope === scope &&
        currentRef.current.session === session &&
        apiSessionVersion() === session &&
        isClientStorageScopeOnCurrentServer(scope),
      send: sendPlaybackReport,
      fetchGeneration,
      isPermanentFailure,
      onCursor: (cursor) =>
        window.dispatchEvent(new CustomEvent(PLAYBACK_CURSOR_UPDATED_EVENT, { detail: { ...cursor, principalID } })),
      warn,
    });
    schedulerRef.current = scheduler;
    void scheduler.initialize();
    const unsubscribe = subscribeListeningHistoryCleared(scope, () => {
      void scheduler.clearHistory();
    });
    const online = () => scheduler.requestFlush();
    window.addEventListener("online", online);
    return () => {
      unsubscribe();
      window.removeEventListener("online", online);
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [scope, session, principalID]);
  return schedulerRef;
}

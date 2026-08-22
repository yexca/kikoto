import { useCallback, useEffect, useState } from "react";

import {
  api,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowRunDetail,
  type WorkflowRunEventStreamMessage,
} from "@/lib/api";

const activeStatuses = new Set(["queued", "running"]);
const foregroundPollMs = 1500;
const backgroundPollMs = 15000;
const streamReconnectMs = 1000;
const cacheRetentionMs = 5 * 60 * 1000;

type WorkflowRunSnapshot = {
  run: WorkflowRunDetail | null;
  events: WorkflowEvent[];
  candidates: WorkflowCandidate[];
  loading: boolean;
  error: string;
};

type WatcherEntry = {
  runId: number;
  snapshot: WorkflowRunSnapshot;
  listeners: Set<(snapshot: WorkflowRunSnapshot) => void>;
  pollListeners: number;
  lastEventId: number;
  inFlight: Promise<void> | null;
  refreshPending: boolean;
  pollTimer: number | null;
  cleanupTimer: number | null;
  streamAbortController: AbortController | null;
  streamTask: Promise<void> | null;
  streamRetryTimer: number | null;
  streamGeneration: number;
  streamTerminal: boolean;
  visibilityListener: () => void;
};

const entries = new Map<number, WatcherEntry>();
const emptySnapshot: WorkflowRunSnapshot = { run: null, events: [], candidates: [], loading: false, error: "" };

export function isActiveWorkflowStatus(status: string | null | undefined) {
  return Boolean(status && activeStatuses.has(status));
}

function getEntry(runId: number) {
  const existing = entries.get(runId);
  if (existing) return existing;
  const entry: WatcherEntry = {
    runId,
    snapshot: { ...emptySnapshot },
    listeners: new Set(),
    pollListeners: 0,
    lastEventId: 0,
    inFlight: null,
    refreshPending: false,
    pollTimer: null,
    cleanupTimer: null,
    streamAbortController: null,
    streamTask: null,
    streamRetryTimer: null,
    streamGeneration: 0,
    streamTerminal: false,
    visibilityListener: () => {
      if (!document.hidden) void refreshEntry(entry);
      startStream(entry);
      schedulePoll(entry);
    },
  };
  entries.set(runId, entry);
  return entry;
}

function publish(entry: WatcherEntry, next: WorkflowRunSnapshot) {
  entry.snapshot = next;
  entry.listeners.forEach((listener) => listener(next));
}

function mergeEvents(entry: WatcherEntry, nextEvents: WorkflowEvent[], replace: boolean) {
  const merged = replace ? nextEvents : [...entry.snapshot.events, ...nextEvents];
  const unique = Array.from(new Map(merged.map((event) => [event.id, event])).values());
  unique.sort((left, right) => left.id - right.id);
  entry.lastEventId = unique.length > 0 ? unique[unique.length - 1].id : 0;
  return unique;
}

function refreshEntry(entry: WatcherEntry, replaceEvents = false) {
  if (entry.inFlight) {
    entry.refreshPending = true;
    return entry.inFlight;
  }
  if (!entry.snapshot.run) publish(entry, { ...entry.snapshot, loading: true, error: "" });
  entry.inFlight = (async () => {
    try {
      const afterId = replaceEvents ? 0 : entry.lastEventId;
      const [nextRun, nextEvents] = await Promise.all([
        api.getWorkflowRun(entry.runId),
        api.listWorkflowRunEvents(entry.runId, afterId),
      ]);
      const shouldLoadCandidates = nextRun.candidateCount > 0 || entry.snapshot.candidates.length > 0;
      const nextCandidates = shouldLoadCandidates ? await api.listWorkflowRunCandidates(entry.runId) : [];
      if (isActiveWorkflowStatus(nextRun.status)) entry.streamTerminal = false;
      publish(entry, {
        run: nextRun,
        events: mergeEvents(entry, nextEvents, replaceEvents),
        candidates: nextCandidates,
        loading: false,
        error: "",
      });
    } catch (cause) {
      publish(entry, {
        ...entry.snapshot,
        loading: false,
        error: cause instanceof Error ? cause.message : "Workflow run refresh failed.",
      });
    } finally {
      entry.inFlight = null;
      if (entry.refreshPending) {
        entry.refreshPending = false;
        void refreshEntry(entry);
      }
      if (entry.listeners.size > 0 && entry.pollListeners > 0 && isActiveWorkflowStatus(entry.snapshot.run?.status)) {
        startStream(entry);
        schedulePoll(entry);
      } else if (!isActiveWorkflowStatus(entry.snapshot.run?.status)) {
        clearPoll(entry);
      }
    }
  })();
  return entry.inFlight;
}

function clearPoll(entry: WatcherEntry) {
  if (entry.pollTimer !== null) window.clearTimeout(entry.pollTimer);
  entry.pollTimer = null;
}

function schedulePoll(entry: WatcherEntry) {
  clearPoll(entry);
  if (
    entry.pollListeners === 0 ||
    entry.streamTask !== null ||
    (entry.snapshot.run && !isActiveWorkflowStatus(entry.snapshot.run.status))
  ) {
    return;
  }
  const delay = entry.snapshot.run ? (document.hidden ? backgroundPollMs : foregroundPollMs) : 0;
  entry.pollTimer = window.setTimeout(() => {
    entry.pollTimer = null;
    void refreshEntry(entry).finally(() => schedulePoll(entry));
  }, delay);
}

function clearStreamRetry(entry: WatcherEntry) {
  if (entry.streamRetryTimer !== null) window.clearTimeout(entry.streamRetryTimer);
  entry.streamRetryTimer = null;
}

function stopStream(entry: WatcherEntry) {
  entry.streamGeneration += 1;
  entry.streamAbortController?.abort();
  entry.streamAbortController = null;
  entry.streamTask = null;
  clearStreamRetry(entry);
}

function scheduleStreamReconnect(entry: WatcherEntry) {
  if (
    entry.streamRetryTimer !== null ||
    entry.streamTerminal ||
    entry.listeners.size === 0 ||
    entry.pollListeners === 0 ||
    !isActiveWorkflowStatus(entry.snapshot.run?.status)
  ) {
    return;
  }
  entry.streamRetryTimer = window.setTimeout(() => {
    entry.streamRetryTimer = null;
    startStream(entry);
  }, streamReconnectMs);
}

function startStream(entry: WatcherEntry) {
  if (
    entry.streamTask !== null ||
    entry.streamTerminal ||
    entry.listeners.size === 0 ||
    entry.pollListeners === 0 ||
    !isActiveWorkflowStatus(entry.snapshot.run?.status)
  ) {
    return;
  }
  clearPoll(entry);
  clearStreamRetry(entry);
  const generation = entry.streamGeneration + 1;
  entry.streamGeneration = generation;
  const controller = new AbortController();
  entry.streamAbortController = controller;
  entry.streamTask = (async () => {
    try {
      await api.streamWorkflowRunEvents(entry.runId, entry.lastEventId, controller.signal, (message) => {
        if (generation !== entry.streamGeneration) return;
        handleStreamMessage(entry, message);
      });
    } catch (cause) {
      if (!controller.signal.aborted && generation === entry.streamGeneration) {
        const message = cause instanceof Error ? cause.message : "Workflow event stream failed.";
        if (!entry.snapshot.error) publish(entry, { ...entry.snapshot, error: message });
      }
    } finally {
      if (generation === entry.streamGeneration) {
        entry.streamTask = null;
        entry.streamAbortController = null;
        if (entry.listeners.size > 0 && entry.pollListeners > 0 && !entry.streamTerminal) {
          schedulePoll(entry);
          scheduleStreamReconnect(entry);
        }
      }
    }
  })();
}

function handleStreamMessage(entry: WatcherEntry, message: WorkflowRunEventStreamMessage) {
  if (message.type === "tick" && message.status && !isActiveWorkflowStatus(message.status)) {
    entry.streamTerminal = true;
  }
  void refreshEntry(entry);
}

function subscribeToRun(runId: number, poll: boolean, listener: (snapshot: WorkflowRunSnapshot) => void) {
  const entry = getEntry(runId);
  if (entry.cleanupTimer !== null) window.clearTimeout(entry.cleanupTimer);
  entry.cleanupTimer = null;
  const wasEmpty = entry.listeners.size === 0;
  entry.listeners.add(listener);
  if (poll) entry.pollListeners += 1;
  listener(entry.snapshot);
  if (wasEmpty) {
    document.addEventListener("visibilitychange", entry.visibilityListener);
    void refreshEntry(entry, entry.snapshot.events.length === 0).finally(() => {
      startStream(entry);
      schedulePoll(entry);
    });
  } else {
    startStream(entry);
    schedulePoll(entry);
  }
  return () => {
    entry.listeners.delete(listener);
    if (poll) entry.pollListeners = Math.max(0, entry.pollListeners - 1);
    if (entry.listeners.size > 0) {
      schedulePoll(entry);
      return;
    }
    clearPoll(entry);
    stopStream(entry);
    document.removeEventListener("visibilitychange", entry.visibilityListener);
    entry.cleanupTimer = window.setTimeout(() => {
      if (entry.listeners.size === 0) entries.delete(runId);
    }, cacheRetentionMs);
  };
}

export function useWorkflowRunWatcher(runId: number | null, poll = true) {
  const [snapshot, setSnapshot] = useState<WorkflowRunSnapshot>(emptySnapshot);

  useEffect(() => {
    if (!runId) {
      setSnapshot(emptySnapshot);
      return;
    }
    return subscribeToRun(runId, poll, setSnapshot);
  }, [poll, runId]);

  const refresh = useCallback(
    async (replaceEvents = false) => {
      if (!runId) return;
      await refreshEntry(getEntry(runId), replaceEvents);
    },
    [runId],
  );

  return { ...snapshot, refresh };
}

import { useCallback, useEffect, useState } from "react";

import {
  api,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowRunDetail,
} from "@/lib/api";

const activeStatuses = new Set(["queued", "running"]);
const foregroundPollMs = 1500;
const backgroundPollMs = 15000;
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
  pollTimer: number | null;
  cleanupTimer: number | null;
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
    pollTimer: null,
    cleanupTimer: null,
    visibilityListener: () => schedulePoll(entry),
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
  if (entry.inFlight) return entry.inFlight;
  if (!entry.snapshot.run) publish(entry, { ...entry.snapshot, loading: true, error: "" });
  entry.inFlight = (async () => {
    try {
      const afterId = replaceEvents ? 0 : entry.lastEventId;
      const [nextRun, nextEvents] = await Promise.all([
        api.getWorkflowRun(entry.runId),
        api.listWorkflowRunEvents(entry.runId, afterId),
      ]);
      const shouldLoadCandidates = nextRun.candidateCount > 0 || entry.snapshot.candidates.length > 0;
      const nextCandidates = shouldLoadCandidates
        ? await api.listWorkflowRunCandidates(entry.runId)
        : [];
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
  if (entry.pollListeners === 0 || (entry.snapshot.run && !isActiveWorkflowStatus(entry.snapshot.run.status))) return;
  const delay = entry.snapshot.run ? (document.hidden ? backgroundPollMs : foregroundPollMs) : 0;
  entry.pollTimer = window.setTimeout(() => {
    entry.pollTimer = null;
    void refreshEntry(entry).finally(() => schedulePoll(entry));
  }, delay);
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
    void refreshEntry(entry, entry.snapshot.events.length === 0).finally(() => schedulePoll(entry));
  } else {
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

  const refresh = useCallback(async (replaceEvents = false) => {
    if (!runId) return;
    await refreshEntry(getEntry(runId), replaceEvents);
  }, [runId]);

  return { ...snapshot, refresh };
}

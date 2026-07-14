import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  type WorkflowCandidate,
  type WorkflowEvent,
  type WorkflowRunDetail,
} from "@/lib/api";

const activeStatuses = new Set(["queued", "running"]);

export function isActiveWorkflowStatus(status: string | null | undefined) {
  return Boolean(status && activeStatuses.has(status));
}

export function useWorkflowRunWatcher(runId: number | null, poll = true) {
  const [run, setRun] = useState<WorkflowRunDetail | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [candidates, setCandidates] = useState<WorkflowCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const generation = useRef(0);
  const lastEventId = useRef(0);

  const refresh = useCallback(async (replaceEvents = false) => {
    if (!runId || inFlight.current) return;
    const currentGeneration = generation.current;
    inFlight.current = true;
    try {
      const afterId = replaceEvents ? 0 : lastEventId.current;
      const [nextRun, nextEvents, nextCandidates] = await Promise.all([
        api.getWorkflowRun(runId),
        api.listWorkflowRunEvents(runId, afterId),
        api.listWorkflowRunCandidates(runId),
      ]);
      if (generation.current !== currentGeneration) return;
      setRun(nextRun);
      setCandidates(nextCandidates);
      setEvents((current) => {
        const merged = replaceEvents ? nextEvents : [...current, ...nextEvents];
        const unique = Array.from(new Map(merged.map((event) => [event.id, event])).values());
        unique.sort((left, right) => left.id - right.id);
        lastEventId.current = unique.length > 0 ? unique[unique.length - 1].id : 0;
        return unique;
      });
      setError("");
    } catch (cause) {
      if (generation.current === currentGeneration) {
        setError(cause instanceof Error ? cause.message : "Workflow run refresh failed.");
      }
    } finally {
      if (generation.current === currentGeneration) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [runId]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    lastEventId.current = 0;
    setRun(null);
    setEvents([]);
    setCandidates([]);
    setError("");
    setLoading(Boolean(runId));
    if (runId) void refresh(true);
  }, [runId, refresh]);

  useEffect(() => {
    if (!runId || !poll || (run && !isActiveWorkflowStatus(run.status))) return;
    const timer = window.setInterval(() => void refresh(false), 1500);
    return () => window.clearInterval(timer);
  }, [poll, refresh, run?.status, runId]);

  return { run, events, candidates, loading, error, refresh };
}

import { useCallback, useEffect, useState } from "react";

import { api, type WorkflowRun } from "@/lib/api";

const activeListSize = 50;
const busyPollMs = 3000;
const idlePollMs = 15_000;

type ActiveQueue = {
  /** Queued and running runs across every workflow, newest first. */
  runs: WorkflowRun[];
  running: number;
  attention: number;
};

/**
 * The newest run of each listed operation. The active queue is polled, quickly
 * only while work is active, so a run started by a schedule, at startup, or in
 * another browser shows on its operation; each operation's latest run reloads
 * when the queue changes instead of on its own timer.
 */
export function useOperationRuns({
  codes,
  refreshKey,
  staticDemo,
}: {
  codes: string[];
  refreshKey: number;
  staticDemo: boolean;
}) {
  const [queue, setQueue] = useState<ActiveQueue>({ runs: [], running: 0, attention: 0 });
  const [latest, setLatest] = useState<Record<string, WorkflowRun | null>>({});
  const busy = queue.running > 0;

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const page = await api.listWorkflowRuns(1, activeListSize, "running", "", "", controller.signal);
        if (controller.signal.aborted) return;
        setQueue({
          runs: page.runs,
          running: page.viewTotals?.running ?? page.total,
          attention: page.viewTotals?.attention ?? 0,
        });
      } catch {
        // Keep the last known queue; the run lists report load failures where they block a task.
      } finally {
        fetching = false;
      }
    };
    void load();
    if (staticDemo) return () => controller.abort();
    const timer = window.setInterval(() => void load(), busy ? busyPollMs : idlePollMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [busy, refreshKey, staticDemo]);

  const codesKey = codes.join(",");
  const queueSignature = `${queue.runs.map((run) => `${run.id}:${run.status}`).join(",")}|${queue.running}|${queue.attention}`;
  useEffect(() => {
    if (!codesKey) return;
    const controller = new AbortController();
    void Promise.all(
      codesKey.split(",").map((code) =>
        api
          .listWorkflowRuns(1, 1, "", "", code, controller.signal)
          .then((page) => [code, page.runs[0] ?? null] as const)
          .catch(() => null),
      ),
    ).then((entries) => {
      if (controller.signal.aborted) return;
      setLatest((current) => {
        const next = { ...current };
        for (const entry of entries) if (entry) next[entry[0]] = entry[1];
        return next;
      });
    });
    return () => controller.abort();
  }, [codesKey, queueSignature, refreshKey]);

  /** The operation's queued and running runs, newest first. */
  const activeRunsOf = useCallback(
    (code: string) => queue.runs.filter((run) => run.workflowCode === code),
    [queue.runs],
  );

  /**
   * The run that states an operation's status: its active run when it has one,
   * a running one ahead of a queued one, otherwise its newest run. `undefined`
   * until the first answer and `null` for an operation that never ran.
   */
  const runOf = useCallback(
    (code: string): WorkflowRun | null | undefined => {
      const active = activeRunsOf(code);
      return active.find((run) => run.status === "running") ?? active[0] ?? latest[code];
    },
    [activeRunsOf, latest],
  );

  return {
    /** Queued and running runs of every workflow, newest first, up to the list size. */
    activeRuns: queue.runs,
    running: queue.running,
    attention: queue.attention,
    runOf,
    activeRunsOf,
  };
}

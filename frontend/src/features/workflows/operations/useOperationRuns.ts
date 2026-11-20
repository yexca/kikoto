import { useCallback, useEffect, useState } from "react";

import { api, type WorkflowRun, type WorkflowStatus } from "@/lib/api";

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
 * The status of each listed operation, from the server. The status and the
 * active queue are polled together, quickly only while work is active, so a
 * run started by a schedule, at startup, or in another browser shows on its
 * operation. The queue only feeds the Running list; an operation's run, its
 * active count, and whether it needs review come from its status, which holds
 * however many runs are active.
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
  const [statuses, setStatuses] = useState<Record<string, WorkflowStatus>>({});
  const busy = queue.running > 0;
  const codesKey = codes.join(",");

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      const wanted = codesKey ? codesKey.split(",") : [];
      try {
        // Each answer stands alone; one that fails keeps its last known state.
        const [page, listed] = await Promise.allSettled([
          api.listWorkflowRuns(1, activeListSize, "running", "", "", controller.signal),
          wanted.length > 0 ? api.listWorkflowStatuses(wanted, controller.signal) : Promise.resolve([]),
        ]);
        if (controller.signal.aborted) return;
        if (page.status === "fulfilled") {
          setQueue({
            runs: page.value.runs,
            running: page.value.viewTotals?.running ?? page.value.total,
            attention: page.value.viewTotals?.attention ?? 0,
          });
        }
        // Run lists report load failures where they block a task.
        if (listed.status === "fulfilled") {
          setStatuses((current) => {
            const next = { ...current };
            for (const status of listed.value) next[status.code] = status;
            return next;
          });
        }
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
  }, [busy, codesKey, refreshKey, staticDemo]);

  /** The operation's status; `undefined` until the first answer. */
  const statusOf = useCallback((code: string): WorkflowStatus | undefined => statuses[code], [statuses]);

  return {
    /** Queued and running runs of every workflow, newest first, up to the list size. */
    activeRuns: queue.runs,
    running: queue.running,
    attention: queue.attention,
    statusOf,
  };
}

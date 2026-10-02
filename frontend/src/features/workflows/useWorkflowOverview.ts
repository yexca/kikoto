import { useEffect, useState } from "react";

import { api, type WorkflowRun } from "@/lib/api";

export type WorkflowPulseState = {
  /** The newest active runs across every workflow, for the status strip. */
  active: WorkflowRun[];
  running: number;
  attention: number;
  loaded: boolean;
};

const activePreviewSize = 4;
const busyPollMs = 3000;
const idlePollMs = 15_000;

/**
 * Page-wide workflow status: the active queue with its attention count, and the
 * latest run of each listed workflow. The queue polls quickly only while work is
 * active; the per-workflow summaries reload when the queue changes instead of on
 * their own timer.
 */
export function useWorkflowOverview({
  codes,
  refreshKey,
  staticDemo,
}: {
  codes: string[];
  refreshKey: number;
  staticDemo: boolean;
}) {
  const [pulse, setPulse] = useState<WorkflowPulseState>({ active: [], running: 0, attention: 0, loaded: false });
  const [latest, setLatest] = useState<Record<string, WorkflowRun | null>>({});
  const busy = pulse.running > 0;

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const page = await api.listWorkflowRuns(1, activePreviewSize, "running", "", "", controller.signal);
        if (controller.signal.aborted) return;
        setPulse({
          active: page.runs,
          running: page.viewTotals?.running ?? page.total,
          attention: page.viewTotals?.attention ?? 0,
          loaded: true,
        });
      } catch {
        // Keep the last known queue; Activity reports load failures where they block a task.
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
  const queueSignature = `${pulse.active.map((run) => `${run.id}:${run.status}`).join(",")}|${pulse.running}|${pulse.attention}`;
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

  /** An active run from the faster queue poll wins over the slower per-workflow summary. */
  const latestRun = (code: string): WorkflowRun | null | undefined =>
    pulse.active.find((run) => run.workflowCode === code) ?? latest[code];

  return { pulse, latestRun };
}

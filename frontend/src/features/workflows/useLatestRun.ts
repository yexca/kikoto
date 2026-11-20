import { useEffect, useState } from "react";

import { api, type WorkflowRun } from "@/lib/api";

import { mergeLatestRun, type KnownRun, type LatestRun } from "./latestRunModel";
import { isActiveRunStatus } from "./runPresentation";

const activePollMs = 4000;
const idlePollMs = 20_000;

/**
 * A workflow's newest run, for a settings panel that states it in one line.
 * The workflow status answers for accounts that may open Activity (`enabled`); it
 * reads again while a run is active and on a slow timer otherwise, so a run
 * started by a schedule or in another browser shows. `known` is what the
 * panel's own endpoint reports; it states the run alone for an account that
 * cannot list runs and covers the moment between a request and the list
 * showing it. `undefined` until the first answer, `null` for a workflow that
 * never ran.
 */
export function useLatestRun({
  code,
  enabled,
  known,
}: {
  code: string;
  enabled: boolean;
  known?: KnownRun | null;
}): LatestRun | null | undefined {
  const [listed, setListed] = useState<WorkflowRun | null | undefined>(undefined);
  const knownId = known?.id ?? 0;
  const knownStatus = known?.status ?? "";
  const merged = mergeLatestRun(listed, known);
  const busy = Boolean(merged && isActiveRunStatus(merged.status));

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const [status] = await api.listWorkflowStatuses([code], controller.signal);
        if (!controller.signal.aborted) setListed(status?.latestRun ?? null);
      } catch {
        // Keep the last answer; Activity reports load failures where they block a task.
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), busy ? activePollMs : idlePollMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [busy, code, enabled, knownId, knownStatus]);

  return merged;
}

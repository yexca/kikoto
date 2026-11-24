import { useEffect, useState } from "react";

import { api, type WorkflowRun } from "@/lib/api";
import { createEffectScope } from "@/lib/effectScope";

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
    const scope = createEffectScope();
    let fetching = false;
    const load = () => {
      if (fetching || document.hidden) return;
      fetching = true;
      // A failure keeps the last answer; Activity reports load failures where they block a task.
      scope.load((signal) => api.listWorkflowStatuses([code], signal), {
        onSuccess: ([status]) => setListed(status?.latestRun ?? null),
        onSettled: () => {
          fetching = false;
        },
      });
    };
    load();
    const timer = window.setInterval(load, busy ? activePollMs : idlePollMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      scope.cancel();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [busy, code, enabled, knownId, knownStatus]);

  return merged;
}

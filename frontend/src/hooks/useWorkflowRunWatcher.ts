import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { apiSessionVersion, subscribeApiSession } from "@/lib/apiSession";
import { emptySnapshot, refreshWorkflowRun, subscribeToRun, type WorkflowRunSnapshot } from "@/lib/workflowRunWatcher";

export { isActiveWorkflowStatus, workflowRunSettled } from "@/lib/workflowRunWatcher";

export function useWorkflowRunWatcher(runId: number | null, poll = true) {
  const session = useSyncExternalStore(subscribeApiSession, apiSessionVersion);
  const [state, setState] = useState<{ runId: number | null; session: number; snapshot: WorkflowRunSnapshot }>({
    runId: null,
    session,
    snapshot: emptySnapshot,
  });
  useEffect(() => {
    if (!runId) return;
    return subscribeToRun(runId, poll, (snapshot) => setState({ runId, session, snapshot }));
  }, [poll, runId, session]);
  const refresh = useCallback(
    async (replaceEvents = false) => {
      if (runId && session === apiSessionVersion()) await refreshWorkflowRun(runId, replaceEvents);
    },
    [runId, session],
  );
  const snapshot = state.runId === runId && state.session === session ? state.snapshot : emptySnapshot;
  return { ...snapshot, refresh };
}

import { useEffect, useRef, useState } from "react";

import { api, type WorkflowRunsPage } from "@/lib/api";

const pollMs = 5000;

/**
 * One page of a run list, polled while the page is visible. The answer for an
 * earlier list, filter, or page is never shown for the current one.
 */
export function useRunList({
  view,
  page,
  pageSize,
  workflowCode = "",
  query = "",
  refreshKey,
  staticDemo,
  onPageOutOfRange,
}: {
  view: string;
  page: number;
  pageSize: number;
  workflowCode?: string;
  query?: string;
  refreshKey: number;
  staticDemo: boolean;
  /** The list shrank below the page; receives the last page that still has runs. */
  onPageOutOfRange?: (page: number) => void;
}) {
  const scope = `${view}\n${workflowCode}\n${query}\n${page}\n${pageSize}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; result: WorkflowRunsPage } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const outOfRange = useRef(onPageOutOfRange);
  outOfRange.current = onPageOutOfRange;

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    const load = async () => {
      if (fetching || document.hidden || controller.signal.aborted) return;
      fetching = true;
      try {
        const result = await api.listWorkflowRuns(page, pageSize, view, query, workflowCode, controller.signal);
        if (controller.signal.aborted) return;
        if (page > 1 && result.total <= (page - 1) * pageSize) {
          outOfRange.current?.(Math.max(1, Math.ceil(result.total / pageSize)));
          return;
        }
        setSnapshot({ scope, result });
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        fetching = false;
      }
    };
    void load();
    const timer = staticDemo ? null : window.setInterval(() => void load(), pollMs);
    if (!staticDemo) document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
      if (!staticDemo) document.removeEventListener("visibilitychange", load);
    };
  }, [scope, view, page, pageSize, query, workflowCode, revision, refreshKey, staticDemo]);

  return {
    result: snapshot?.scope === scope ? snapshot.result : null,
    error,
    reload: () => setRevision((value) => value + 1),
  };
}

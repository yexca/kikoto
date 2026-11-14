import { useEffect, useMemo, useState } from "react";

import { WORKFLOWS_PATH, type HistoryStatus, type WorkflowTab } from "@/features/workflows/workflowLinks";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const run = Number(params.get("run"));
  const tab: WorkflowTab = params.get("tab") === "history" ? "history" : "now";
  return {
    tab,
    runId: Number.isSafeInteger(run) && run > 0 ? run : null,
    status: (tab === "history" && params.get("status") === "failed" ? "failed" : "") as HistoryStatus,
    /** The workflow History is narrowed to; empty for every workflow. */
    workflowCode: tab === "history" ? (params.get("workflow") ?? "") : "",
    query: tab === "history" ? (params.get("q") ?? "") : "",
  };
}

/** The Workflows page's address: the list shown, History's filters, and the open run. */
export function useWorkflowsLocation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const sync = () => setLocation(readLocation());
    window.addEventListener(NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  const actions = useMemo(() => {
    const update = (change: (params: URLSearchParams) => void, push = false) => {
      const params = new URLSearchParams(window.location.search);
      change(params);
      window.history[push ? "pushState" : "replaceState"](
        window.history.state,
        "",
        `${WORKFLOWS_PATH}${params.size ? `?${params}` : ""}`,
      );
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    };
    const setOrDelete = (params: URLSearchParams, key: string, value: string) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    return {
      /** Now has no filters, so leaving History drops them. */
      setTab: (tab: WorkflowTab) =>
        update((params) => {
          if (tab === "history") params.set("tab", "history");
          else for (const key of ["tab", "status", "workflow", "q"]) params.delete(key);
        }),
      setStatus: (status: HistoryStatus) => update((params) => setOrDelete(params, "status", status)),
      setWorkflow: (code: string) => update((params) => setOrDelete(params, "workflow", code)),
      setQuery: (query: string) => update((params) => setOrDelete(params, "q", query.trim())),
      /** Opening a run is a history step, so Back returns to the list. */
      openRun: (runId: number) => update((params) => params.set("run", String(runId)), true),
      backToList: () => update((params) => params.delete("run")),
    };
  }, []);
  return { ...location, ...actions };
}

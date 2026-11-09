import { useEffect, useState } from "react";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

export type ActivityView = "attention" | "history";

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const run = Number(params.get("run"));
  const open = params.has("activity") || (!params.has("dialog") && Number.isSafeInteger(run) && run > 0);
  return {
    /** Whether the page shows Activity in place of the selected workflow. */
    open,
    runId: open && Number.isSafeInteger(run) && run > 0 ? run : null,
    workflowCode: params.get("workflow") ?? "",
    /** The workflow whose runs the open Activity list is narrowed to; empty for every workflow. */
    runsOf: open ? (params.get("runsOf") ?? "") : "",
    // Earlier links name the finished list `completed`.
    view: (["history", "completed"].includes(params.get("view") ?? "") ? "history" : "attention") as ActivityView,
  };
}

/**
 * The Workflows page location: the selected workflow, and whether Activity
 * replaces it with every run. Activity keeps `?workflow`, so leaving it
 * returns to the workflow that was open.
 */
export function useWorkflowActivityLocation() {
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
  const update = (change: (params: URLSearchParams) => void, push = false) => {
    const params = new URLSearchParams(window.location.search);
    change(params);
    window.history[push ? "pushState" : "replaceState"](
      window.history.state,
      "",
      `/workflows${params.size ? `?${params}` : ""}`,
    );
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  return {
    ...location,
    /**
     * Shows Activity across every workflow, on the given list when one is named;
     * `push` makes it a history step, as when the mobile list opens it.
     */
    openActivity: (view?: ActivityView, push = false) =>
      update((params) => {
        params.set("activity", "1");
        params.delete("run");
        params.delete("runsOf");
        if (view) params.set("view", view);
      }, push),
    /** Leaves Activity for the workflow that was open before it. */
    closeActivity: () =>
      update((params) => {
        for (const key of ["activity", "run", "runsOf", "view"]) params.delete(key);
      }),
    setView: (view: ActivityView) =>
      update((params) => {
        params.set("view", view);
      }),
    clearWorkflow: () =>
      update((params) => {
        for (const key of ["workflow", "run", "activity", "runsOf", "view", "dialog"]) params.delete(key);
      }),
    /** Selects a workflow, leaving Activity; `push` makes the selection a history step, as when a mobile list opens one. */
    selectWorkflow: (code: string, push = false) =>
      update((params) => {
        params.set("workflow", code);
        for (const key of ["activity", "run", "runsOf", "view", "dialog"]) params.delete(key);
      }, push),
    /** Opens Activity narrowed to one workflow's runs. */
    openWorkflowRuns: (code: string) =>
      update((params) => {
        params.set("activity", "1");
        params.set("runsOf", code);
        params.delete("run");
      }, true),
    /** Widens the open Activity list back to every workflow. */
    showAllWorkflows: () =>
      update((params) => {
        params.delete("runsOf");
      }),
    /** Opens a run in Activity without changing the selected workflow. */
    openRun: (runId: number) =>
      update((params) => {
        params.set("activity", "1");
        params.set("run", String(runId));
      }, true),
    backToList: () =>
      update((params) => {
        params.delete("run");
      }),
  };
}

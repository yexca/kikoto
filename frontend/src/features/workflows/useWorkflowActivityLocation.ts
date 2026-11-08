import { useEffect, useState } from "react";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const run = Number(params.get("run"));
  const open = params.has("activity") || (!params.has("dialog") && Number.isSafeInteger(run) && run > 0);
  return {
    open,
    runId: open && Number.isSafeInteger(run) && run > 0 ? run : null,
    workflowCode: params.get("workflow") ?? "",
    /** The workflow whose runs the open Activity list is narrowed to; empty for every workflow. */
    runsOf: open ? (params.get("runsOf") ?? "") : "",
  };
}

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
    /** Opens or closes Activity across every workflow. */
    setOpen: (open: boolean) =>
      update((params) => {
        params.delete("runsOf");
        if (open) params.set("activity", "1");
        else {
          params.delete("activity");
          params.delete("run");
        }
      }),
    resolveWorkflow: (code: string) =>
      update((params) => {
        params.set("workflow", code);
      }),
    clearWorkflow: () =>
      update((params) => {
        for (const key of ["workflow", "run", "activity", "runsOf", "view", "dialog"]) params.delete(key);
      }),
    /** Selects a workflow; `push` makes the selection a history step, as when a mobile list opens one. */
    selectWorkflow: (code: string, push = false) =>
      update((params) => {
        params.set("workflow", code);
        params.delete("run");
        params.delete("runsOf");
        params.delete("view");
        params.delete("dialog");
      }, push),
    /** Opens the Activity list, where a newly queued run appears with the active runs. */
    openList: () =>
      update((params) => {
        params.set("activity", "1");
        params.delete("run");
        params.delete("runsOf");
      }, true),
    /** Opens the Activity list narrowed to one workflow's runs. */
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
    openRun: (runId: number, workflowCode?: string) =>
      update((params) => {
        params.set("activity", "1");
        params.set("run", String(runId));
        if (workflowCode) params.set("workflow", workflowCode);
        else params.delete("workflow");
      }, true),
    backToList: () =>
      update((params) => {
        params.delete("run");
      }),
  };
}

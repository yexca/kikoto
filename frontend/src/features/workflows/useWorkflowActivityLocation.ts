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
    setOpen: (open: boolean) =>
      update((params) => {
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
        for (const key of ["workflow", "run", "activity", "view", "dialog"]) params.delete(key);
      }),
    selectWorkflow: (code: string) =>
      update((params) => {
        params.set("workflow", code);
        params.delete("run");
        params.delete("view");
        params.delete("dialog");
      }),
    /** Opens the Activity list, where a newly queued run appears with the active runs. */
    openList: () =>
      update((params) => {
        params.set("activity", "1");
        params.delete("run");
      }, true),
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

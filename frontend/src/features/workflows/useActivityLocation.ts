import { useEffect, useMemo, useState } from "react";

import { ACTIVITY_PATH, type ActivityView } from "@/features/workflows/workflowLinks";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** Names earlier links use for a list. */
const viewAliases: Record<string, ActivityView> = {
  running: "running",
  attention: "attention",
  review: "attention",
  failed: "failed",
  history: "history",
  completed: "history",
  logs: "history",
};

export function activityViewFromParam(value: string | null): ActivityView {
  return viewAliases[value ?? ""] ?? "all";
}

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const run = Number(params.get("run"));
  return {
    runId: Number.isSafeInteger(run) && run > 0 ? run : null,
    view: activityViewFromParam(params.get("view")),
    /** The workflow whose runs the list is narrowed to; empty for every workflow. */
    workflowCode: params.get("workflow") ?? "",
    query: params.get("q") ?? "",
  };
}

/** The Activity page's address: the list shown, its filters, and the open run. */
export function useActivityLocation() {
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
        `${ACTIVITY_PATH}${params.size ? `?${params}` : ""}`,
      );
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    };
    const setOrDelete = (params: URLSearchParams, key: string, value: string) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    return {
      setView: (view: ActivityView) => update((params) => setOrDelete(params, "view", view === "all" ? "" : view)),
      setWorkflow: (code: string) => update((params) => setOrDelete(params, "workflow", code)),
      setQuery: (query: string) => update((params) => setOrDelete(params, "q", query.trim())),
      /** Opening a run is a history step, so Back returns to the list. */
      openRun: (runId: number) => update((params) => params.set("run", String(runId)), true),
      backToList: () => update((params) => params.delete("run")),
    };
  }, []);
  return { ...location, ...actions };
}

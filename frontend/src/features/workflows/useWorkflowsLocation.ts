import { useEffect, useMemo, useState } from "react";

import {
  WORKFLOWS_PATH,
  workflowTabFromParam,
  type HistoryStatus,
  type WorkflowTab,
} from "@/features/workflows/workflowLinks";
import { NAVIGATION_EVENT, navigateBackOr } from "@/lib/browserHistory";

/** Marks an entry this page pushed to open a run, so closing the run steps back to the entry below. */
const openedRunStateKey = "__kikotoWorkflowRunOpened";

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const run = Number(params.get("run"));
  const tab = workflowTabFromParam(params.get("tab"));
  const runId = Number.isSafeInteger(run) && run > 0 ? run : null;
  return {
    tab,
    runId,
    /**
     * The open run belongs to the list it was chosen from, Needs attention or
     * History, and shows beside it on wide screens. A run opened from anywhere
     * else, or by a link, takes the page on its own.
     */
    runInList: runId !== null && tab !== "operations",
    status: (tab === "history" && params.get("status") === "failed" ? "failed" : "") as HistoryStatus,
    /** The workflow History is narrowed to; empty for every workflow. */
    workflowCode: tab === "history" ? (params.get("workflow") ?? "") : "",
    query: tab === "history" ? (params.get("q") ?? "") : "",
  };
}

function openedHere(state: unknown) {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[openedRunStateKey] === true;
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
    const write = (params: URLSearchParams, push: boolean) => {
      const href = `${WORKFLOWS_PATH}${params.size ? `?${params}` : ""}`;
      if (push) window.history.pushState({ ...window.history.state, [openedRunStateKey]: true }, "", href);
      else window.history.replaceState(window.history.state, "", href);
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    };
    const update = (change: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(window.location.search);
      change(params);
      write(params, false);
    };
    const setOrDelete = (params: URLSearchParams, key: string, value: string) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    /** Another list or filter shows other runs, so the open run closes with it. */
    const changeList = (change: (params: URLSearchParams) => void) =>
      update((params) => {
        change(params);
        params.delete("run");
      });
    const runOpen = () => new URLSearchParams(window.location.search).has("run");
    return {
      /** Only History has filters, so leaving it drops them. */
      setTab: (tab: WorkflowTab) =>
        changeList((params) => {
          if (tab !== "history") for (const key of ["status", "workflow", "q"]) params.delete(key);
          if (tab === "operations") params.delete("tab");
          else params.set("tab", tab);
        }),
      setStatus: (status: HistoryStatus) => changeList((params) => setOrDelete(params, "status", status)),
      setWorkflow: (code: string) => changeList((params) => setOrDelete(params, "workflow", code)),
      setQuery: (query: string) => changeList((params) => setOrDelete(params, "q", query.trim())),
      /**
       * Opens a run of the list shown, beside it. Opening the first run is a
       * history step, so Back returns to the list; choosing another run while
       * one is open replaces it.
       */
      openListRun: (runId: number) => {
        const params = new URLSearchParams(window.location.search);
        const push = !params.has("run");
        params.set("run", String(runId));
        write(params, push);
      },
      /**
       * Opens a run on its own, as a link to it does: from what is running, an
       * operation's state, or a notice. Back returns to the list and filters
       * it was opened from.
       */
      openRun: (runId: number) => write(new URLSearchParams({ run: String(runId) }), true),
      /** Steps back to the entry the run was opened from, or drops the run from a linked address. */
      closeRun: () => {
        if (!runOpen()) return;
        const drop = () => update((params) => params.delete("run"));
        if (openedHere(window.history.state)) navigateBackOr(drop);
        else drop();
      },
    };
  }, []);
  return { ...location, ...actions };
}

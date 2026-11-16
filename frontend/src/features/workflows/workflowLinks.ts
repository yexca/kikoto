import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** Addresses of the Workflows page: its run lists, one run, and the links other pages use to open them. */

export const WORKFLOWS_PATH = "/workflows";

/** What goes on now (running, needing attention, next) and the runs that ended. */
export const workflowTabs = ["now", "history"] as const;
export type WorkflowTab = (typeof workflowTabs)[number];

/** History narrowed to failed runs; empty for every ended run. */
export type HistoryStatus = "" | "failed";

/** Workflows on one of its lists; the status and workflow narrow History. */
export function workflowsPath({
  tab,
  status,
  workflow,
}: { tab?: WorkflowTab; status?: HistoryStatus; workflow?: string } = {}) {
  const params = new URLSearchParams();
  if (tab === "history") {
    params.set("tab", "history");
    if (status) params.set("status", status);
    if (workflow) params.set("workflow", workflow);
  }
  return `${WORKFLOWS_PATH}${params.size ? `?${params}` : ""}`;
}

export function workflowRunPath(runId: number) {
  return `${WORKFLOWS_PATH}?run=${runId}`;
}

export function openWorkflowPath(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * Where an earlier address of the run log leads: `/activity` and `/runs`, and
 * `/workflows?activity=1`, open Workflows with the run they named and, for a
 * list of ended runs, History with its workflow. Any other address returns
 * null.
 */
export function legacyRunLogPath(path: string, search: string): string | null {
  const params = new URLSearchParams(search);
  if (path === WORKFLOWS_PATH ? !params.has("activity") : path !== "/activity" && path !== "/runs") return null;
  const view = params.get("view") ?? "";
  const tab: WorkflowTab = ["failed", "history", "completed", "logs"].includes(view) ? "history" : "now";
  const run = Number(params.get("run"));
  const target = workflowsPath({
    tab,
    status: view === "failed" ? "failed" : "",
    workflow: params.get("runsOf") ?? (path === WORKFLOWS_PATH ? "" : (params.get("workflow") ?? "")),
  });
  if (!Number.isSafeInteger(run) || run <= 0) return target;
  return `${target}${target.includes("?") ? "&" : "?"}run=${run}`;
}

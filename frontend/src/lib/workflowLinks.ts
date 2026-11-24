import { NAVIGATION_EVENT } from "./browserHistory";

/**
 * Addresses of the Workflows page: its run lists, one run, and the links other
 * pages use to open them. This module is the only place that spells one; it
 * lives in `lib` so shared code and every feature can open a run without
 * importing a feature. `oxlint-workflow-links.mjs` rejects an address written
 * anywhere else.
 */

export const WORKFLOWS_PATH = "/workflows";

/**
 * The tabs under what is running: the operations with what runs next, the
 * runs that need attention, and the runs that ended.
 */
export const workflowTabs = ["operations", "attention", "history"] as const;
export type WorkflowTab = (typeof workflowTabs)[number];

/** The tab an address names; Operations without one, and for an earlier address's `now`. */
export function workflowTabFromParam(value: string | null): WorkflowTab {
  return value === "attention" || value === "history" ? value : "operations";
}

/** History narrowed to failed runs; empty for every ended run. */
export type HistoryStatus = "" | "failed";

/** Workflows on one of its tabs; the status and workflow narrow History. */
export function workflowsPath({
  tab,
  status,
  workflow,
}: { tab?: WorkflowTab; status?: HistoryStatus; workflow?: string } = {}) {
  const params = new URLSearchParams();
  if (tab === "attention") params.set("tab", "attention");
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

/** Pushes an address of Workflows and tells the app shell the location changed. */
export function openWorkflowPath(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** Opens one run on its own page, the action behind every "open the run" toast and link. */
export function openWorkflowRun(runId: number) {
  openWorkflowPath(workflowRunPath(runId));
}

/**
 * Where an earlier address of the run log leads: `/activity` and `/runs`, and
 * `/workflows?activity=1`, open Workflows with the run they named and, for a
 * list of ended runs, History with the workflow `runsOf` named. Any other
 * address returns null.
 */
export function legacyRunLogPath(path: string, search: string): string | null {
  const params = new URLSearchParams(search);
  if (path === WORKFLOWS_PATH ? !params.has("activity") : path !== "/activity" && path !== "/runs") return null;
  const view = params.get("view") ?? "";
  const tab: WorkflowTab = ["failed", "history", "completed", "logs"].includes(view)
    ? "history"
    : view === "attention"
      ? "attention"
      : "operations";
  const run = Number(params.get("run"));
  const target = workflowsPath({
    tab,
    status: view === "failed" ? "failed" : "",
    workflow: params.get("runsOf") ?? "",
  });
  if (!Number.isSafeInteger(run) || run <= 0) return target;
  return `${target}${target.includes("?") ? "&" : "?"}run=${run}`;
}

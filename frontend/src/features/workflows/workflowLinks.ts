import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** Links other pages use to open Workflows and to open runs in Activity. */

export const OPERATIONS_PATH = "/workflows";
export const ACTIVITY_PATH = "/activity";

/** The lists Activity filters its runs by; `all` is every run, newest first. */
export const activityViews = ["all", "running", "attention", "failed", "history"] as const;
export type ActivityView = (typeof activityViews)[number];

/** Activity on one of its lists, optionally narrowed to one workflow's runs. */
export function activityPath({ view, workflow }: { view?: ActivityView; workflow?: string } = {}) {
  const params = new URLSearchParams();
  if (view && view !== "all") params.set("view", view);
  if (workflow) params.set("workflow", workflow);
  return `${ACTIVITY_PATH}${params.size ? `?${params}` : ""}`;
}

export function workflowActivityRunPath(runId: number) {
  return `${ACTIVITY_PATH}?run=${runId}`;
}

export function openWorkflowPath(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * Where an address that showed Activity inside the Workflows page leads:
 * `?activity=1`, or a bare `?run=`, with the list and the workflow scope it
 * named. The workflow that was selected behind Activity is not a filter and is
 * dropped. Any other address returns null.
 */
export function legacyWorkflowActivityPath(search: string): string | null {
  const params = new URLSearchParams(search);
  const run = Number(params.get("run"));
  const hasRun = Number.isSafeInteger(run) && run > 0;
  if (!params.has("activity") && (params.has("dialog") || !hasRun)) return null;
  const next = new URLSearchParams();
  const view = params.get("view");
  if (view) next.set("view", view);
  const scope = params.get("runsOf");
  if (scope) next.set("workflow", scope);
  if (hasRun) next.set("run", String(run));
  return `${ACTIVITY_PATH}${next.size ? `?${next}` : ""}`;
}

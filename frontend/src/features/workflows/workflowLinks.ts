import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/**
 * Links other pages use to hand work to Workflows. A run-form link selects a
 * workflow and prefills its target, so a detail page can offer a shortcut
 * without owning the workflow's options.
 */

const prefillKeys = ["circleId", "personId"] as const;

export type WorkflowRunPrefillKey = (typeof prefillKeys)[number];
export type WorkflowRunPrefill = Partial<Record<WorkflowRunPrefillKey, string>>;

export function workflowRunFormPath(code: string, prefill: WorkflowRunPrefill = {}) {
  const params = new URLSearchParams({ workflow: code });
  for (const key of prefillKeys) {
    const value = prefill[key]?.trim();
    if (value) params.set(key, value);
  }
  return `/workflows?${params}`;
}

export function workflowActivityRunPath(runId: number) {
  return `/workflows?activity=1&run=${runId}`;
}

export function openWorkflowPath(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** Returns the prefill a run-form link carries for this workflow, if any. */
export function readWorkflowRunPrefill(code: string, search = window.location.search): WorkflowRunPrefill {
  const params = new URLSearchParams(search);
  if (params.get("workflow") !== code) return {};
  const prefill: WorkflowRunPrefill = {};
  for (const key of prefillKeys) {
    const value = params.get(key)?.trim();
    if (value) prefill[key] = value;
  }
  return prefill;
}

/** Drops consumed prefill so a reload or a later workflow switch does not reapply it. */
export function clearWorkflowRunPrefill() {
  const params = new URLSearchParams(window.location.search);
  if (!prefillKeys.some((key) => params.has(key))) return;
  for (const key of prefillKeys) params.delete(key);
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${params.size ? `?${params}` : ""}`,
  );
}

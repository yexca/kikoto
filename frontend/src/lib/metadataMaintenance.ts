import { NAVIGATION_EVENT } from "./browserHistory";

export function openMetadataIssues(runId: number) {
  window.history.pushState({}, "", metadataIssuesURL(runId));
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function metadataIssuesURL(runId?: number) {
  const params = new URLSearchParams({ reason: "metadata" });
  if (runId && Number.isSafeInteger(runId) && runId > 0) params.set("metadataRun", String(runId));
  return `/work-management?${params}`;
}

export function metadataIssueRunFromLocation() {
  const id = Number(new URLSearchParams(window.location.search).get("metadataRun"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

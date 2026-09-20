import { NAVIGATION_EVENT } from "./browserHistory";

export function openMetadataIssues(runId: number) {
  window.history.pushState({}, "", metadataIssuesURL(runId));
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function metadataIssuesURL(runId?: number) {
  const params = new URLSearchParams({ reason: "metadata" });
  if (runId && Number.isSafeInteger(runId) && runId > 0) params.set("metadataRun", String(runId));
  return `/metadata?${params}`;
}

export function metadataIssueRunFromLocation() {
  const id = Number(new URLSearchParams(window.location.search).get("metadataRun"));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// A run-scoped issue read also requires workflow access. Metadata-only operators
// can still recover issues, through the unscoped Metadata issues category.
export function metadataSyncResultURL(runId: number, needsAttention: boolean, canViewActivity: boolean) {
  if (needsAttention) return metadataIssuesURL(canViewActivity ? runId : undefined);
  return canViewActivity && Number.isSafeInteger(runId) && runId > 0
    ? `/workflows?workflow=metadata_sync&activity=1&run=${runId}`
    : "/metadata";
}

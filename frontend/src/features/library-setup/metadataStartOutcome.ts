/**
 * What asking the server to start the first metadata sync led to. The server
 * queues a run only when works are waiting for metadata; every other answer
 * reports the current state instead, and no run was started by the request.
 */
export type MetadataStartOutcome = "queued" | "waiting" | "finished" | "not_started" | "attention";

export function metadataStartOutcome(status: string): MetadataStartOutcome {
  switch (status) {
    case "queued":
    case "running":
      return "queued";
    case "waiting":
      return "waiting";
    case "succeeded":
      return "finished";
    case "hidden":
      return "not_started";
    default:
      return "attention";
  }
}

/** Whether a sync is under way or done, so starting again has nothing to add. */
export function metadataStartSettled(outcome: MetadataStartOutcome | null) {
  return outcome === "queued" || outcome === "finished";
}

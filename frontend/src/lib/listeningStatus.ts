import type { ListeningStatus } from "@/lib/api";

const listeningStatuses: readonly ListeningStatus[] = [
  "none",
  "want_to_listen",
  "listening",
  "finished",
  "relisten",
  "paused",
];

/** A status as a response carries it, with anything unknown read as unmarked. */
export function normalizeListeningStatus(status: string): ListeningStatus {
  return (listeningStatuses as readonly string[]).includes(status) ? (status as ListeningStatus) : "none";
}

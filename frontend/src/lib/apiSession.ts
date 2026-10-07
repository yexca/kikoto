import { sharedInflightRequests } from "@/lib/inflightRequests";

// Cookie sessions have no readable token. A generation also distinguishes a
// logout/login cycle into the same account and a switch to another server.
let generation = 0;
let principal: number | null | undefined;

export function apiSessionVersion() {
  return generation;
}

export function changeApiSession() {
  generation += 1;
  principal = undefined;
  sharedInflightRequests.invalidateAll();
}

export function observeApiPrincipal(id: number | null) {
  if (principal !== undefined && principal !== id) changeApiSession();
  principal = id;
}

export function assertApiSession(version: number) {
  if (version !== generation) throw new DOMException("The session has changed.", "AbortError");
}

import { sharedInflightRequests } from "@/lib/inflightRequests";

// A cookie session has no readable token. The generation also distinguishes a
// logout/login into the same account, and native credential/server changes.
let generation = 0;
let principal: number | null | undefined;
let controller = new AbortController();
const listeners = new Set<() => void>();

export class ApiSessionChangedError extends DOMException {
  constructor() {
    super("The session has changed.", "AbortError");
  }
}

export function apiSessionVersion() {
  return generation;
}

/** Invalidate retained account data as soon as the login or server changes. */
export function subscribeApiSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Only resume account-owned queues once this session has confirmed their owner. */
export function apiSessionForPrincipal(id: number | null) {
  return principal === id ? generation : null;
}

export function apiSessionSignal() {
  return controller.signal;
}

export function changeApiSession() {
  generation += 1;
  principal = undefined;
  const previous = controller;
  controller = new AbortController();
  const reason = new ApiSessionChangedError();
  previous.abort(reason);
  sharedInflightRequests.invalidateAll(reason);
  listeners.forEach((listener) => listener());
}

export function observeApiPrincipal(id: number | null) {
  if (principal !== undefined && principal !== id) changeApiSession();
  principal = id;
}

export function assertApiSession(version: number) {
  if (version !== generation) throw new ApiSessionChangedError();
}

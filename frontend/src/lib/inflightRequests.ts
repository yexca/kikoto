// In-flight request sharing: concurrent callers with the same key share one
// underlying request. Nothing is cached after the request settles, so a later
// caller always starts a fresh request.
//
// Each caller may pass its own AbortSignal. A caller that aborts is rejected
// with its signal's reason (an AbortError by default, matching fetch) and is
// detached; the shared request keeps running for the remaining callers. The
// shared request is aborted only when every caller has aborted, and an aborted
// entry is forgotten immediately so a new caller starts a fresh request.

type InflightEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
};

export type InflightRequests = {
  run<T>(key: string, request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Stops new callers from joining requests already in flight; current callers keep theirs. */
  forgetAll(): void;
  size(): number;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function createInflightRequests(): InflightRequests {
  const entries = new Map<string, InflightEntry>();

  function forget(key: string, entry: InflightEntry) {
    if (entries.get(key) === entry) entries.delete(key);
  }

  function start(key: string, request: (signal: AbortSignal) => Promise<unknown>) {
    const controller = new AbortController();
    const entry: InflightEntry = { promise: Promise.resolve(), controller, subscribers: 0 };
    let promise: Promise<unknown>;
    try {
      promise = request(controller.signal);
    } catch (error) {
      promise = Promise.reject(error);
    }
    entry.promise = promise.finally(() => forget(key, entry));
    // Every subscriber attaches its own handlers; this keeps a request whose
    // subscribers all aborted from surfacing as an unhandled rejection.
    entry.promise.catch(() => undefined);
    entries.set(key, entry);
    return entry;
  }

  return {
    run<T>(key: string, request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const entry = entries.get(key) ?? start(key, request);
      entry.subscribers += 1;
      const shared = entry.promise as Promise<T>;
      if (!signal) return shared;

      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(abortReason(signal));
          entry.subscribers -= 1;
          if (entry.subscribers === 0) {
            forget(key, entry);
            entry.controller.abort();
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
    forgetAll: () => entries.clear(),
    size: () => entries.size,
  };
}

// Shared by API reads whose concurrent duplicates should collapse into one.
export const sharedInflightRequests = createInflightRequests();

// Serializes a refresh task: while one run is in flight, any number of further
// calls collapse into a single trailing run. Every returned promise settles
// after a run that started no earlier than its call, so a burst of change
// notifications still ends with fresh data but never overlapping requests.
export function coalesceRuns(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const start = () => {
    const run: Promise<void> = Promise.resolve()
      .then(task)
      .finally(() => {
        if (running === run) running = null;
      });
    running = run;
    return run;
  };

  return () => {
    if (queued) return queued;
    if (!running) return start();
    queued = running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return start();
      });
    return queued;
  };
}

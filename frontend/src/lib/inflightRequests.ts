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
  key: string;
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
  resources: readonly string[];
  invalidate: (reason: unknown) => void;
};

export type InflightRequests = {
  run<T>(
    key: string,
    request: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    resources?: readonly string[],
  ): Promise<T>;
  /** Stops new callers from joining requests already in flight; current callers keep theirs. */
  forgetAll(): void;
  forgetResources(resources: readonly string[]): void;
  /** Interrupts affected reads, which may recover after the resource update settles. */
  invalidateResources(resources: readonly string[], settled?: Promise<void>): void;
  /** Rejects every pending read, including forgotten reads, with the supplied session/cancellation reason. */
  invalidateAll(reason: unknown): void;
  size(): number;
};

export class ResourceInvalidatedError extends Error {
  constructor(readonly settled: Promise<void> = Promise.resolve()) {
    super("The resource has changed. Please retry the request.");
    this.name = "ResourceInvalidatedError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Links request lifetimes without requiring AbortSignal.any on older supported browsers. */
export function combineAbortSignals(first: AbortSignal, second?: AbortSignal | null) {
  if (!second || first === second) return { signal: first, dispose: () => {} };
  const controller = new AbortController();
  const dispose = () => {
    first.removeEventListener("abort", abortFirst);
    second.removeEventListener("abort", abortSecond);
  };
  const abortFirst = () => {
    controller.abort(abortReason(first));
    dispose();
  };
  const abortSecond = () => {
    controller.abort(abortReason(second));
    dispose();
  };
  if (first.aborted) abortFirst();
  else if (second.aborted) abortSecond();
  else {
    first.addEventListener("abort", abortFirst, { once: true });
    second.addEventListener("abort", abortSecond, { once: true });
  }
  return { signal: controller.signal, dispose };
}

export function createInflightRequests(): InflightRequests {
  const entries = new Map<string, InflightEntry>();
  // Eviction only changes reuse. These reads still belong to the session and
  // must be rejected if it changes before their result (or error) arrives.
  const pending = new Set<InflightEntry>();
  const affects = (entry: InflightEntry, resources: readonly string[]) =>
    entry.resources.some((resource) => resources.includes(resource));

  function forget(key: string, entry: InflightEntry) {
    if (entries.get(key) === entry) entries.delete(key);
  }

  function start(key: string, request: (signal: AbortSignal) => Promise<unknown>, resources: readonly string[]) {
    const controller = new AbortController();
    let invalidate = (_reason: unknown) => {};
    const invalidated = new Promise<never>((_, reject) => {
      invalidate = (reason) => {
        reject(reason);
        controller.abort(reason);
      };
    });
    const entry: InflightEntry = { key, promise: Promise.resolve(), controller, subscribers: 0, resources, invalidate };
    let promise: Promise<unknown>;
    try {
      promise = request(controller.signal);
    } catch (error) {
      promise = Promise.reject(error);
    }
    entry.promise = Promise.race([promise, invalidated]).finally(() => {
      forget(key, entry);
      pending.delete(entry);
    });
    // Every subscriber attaches its own handlers; this keeps a request whose
    // subscribers all aborted from surfacing as an unhandled rejection.
    entry.promise.catch(() => undefined);
    entries.set(key, entry);
    pending.add(entry);
    return entry;
  }

  return {
    run<T>(
      key: string,
      request: (signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
      resources: readonly string[] = [],
    ): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      const entry = entries.get(key) ?? start(key, request, resources);
      entry.subscribers += 1;
      const shared = entry.promise as Promise<T>;
      if (!signal) return shared;

      return new Promise<T>((resolve, reject) => {
        let finished = false;
        const detach = () => {
          if (finished) return false;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          entry.subscribers -= 1;
          return true;
        };
        const onAbort = () => {
          if (!detach()) return;
          reject(abortReason(signal));
          if (entry.subscribers === 0) {
            forget(key, entry);
            entry.invalidate(abortReason(signal));
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void shared.then(
          (result) => {
            if (detach()) resolve(result);
          },
          (error) => {
            if (detach()) reject(error);
          },
        );
      });
    },
    forgetAll: () => entries.clear(),
    forgetResources: (resources) => {
      for (const [key, entry] of entries) {
        if (affects(entry, resources)) forget(key, entry);
      }
    },
    invalidateResources: (resources, settled) => {
      for (const entry of pending) {
        if (!affects(entry, resources)) continue;
        forget(entry.key, entry);
        entry.invalidate(new ResourceInvalidatedError(settled));
      }
    },
    invalidateAll: (reason) => {
      entries.clear();
      for (const entry of pending) entry.invalidate(reason);
    },
    size: () => entries.size,
  };
}

// Shared by API reads whose concurrent duplicates should collapse into one.
export const sharedInflightRequests = createInflightRequests();

function waitForResourceUpdate(settled: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return settled;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void settled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Only resource interruptions recover; session changes and caller aborts never restart a read. */
export async function retryInvalidatedRequest<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let recoveries = 0; ; recoveries += 1) {
    signal?.throwIfAborted();
    try {
      const result = await read();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof ResourceInvalidatedError) || recoveries >= 2) throw error;
      await waitForResourceUpdate(error.settled, signal);
    }
  }
}

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

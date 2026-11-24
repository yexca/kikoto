/**
 * The one way an effect loads data or holds a listener that registers
 * asynchronously. A load receives a signal to pass to every API call it
 * makes; cancelling aborts that signal, and from then on neither its result
 * nor its failure reaches the handlers. The transport (`lib/apiTransport.ts`)
 * already rejects a call whose signal aborted or whose session changed, even
 * after the response arrived, so a cancelled load cannot apply stale data.
 *
 * Return the cancel function from the effect:
 *
 * ```ts
 * useEffect(() => {
 *   if (!open) return;
 *   setFailed(false);
 *   return startLoad((signal) => api.getThing(id, signal), {
 *     onSuccess: setThing,
 *     onError: () => setFailed(true),
 *   });
 * }, [id, open]);
 * ```
 *
 * Prefer returning data from the load and applying it in `onSuccess`. A load
 * that sets state between steps passes the signal to each API call, and after
 * any other await (a file read, a native plugin) calls
 * `signal.throwIfAborted()` before touching state.
 */

export type LoadHandlers<T> = {
  /** Receives the result of a load that is still current. */
  onSuccess?: (value: T) => void;
  /**
   * Receives the failure of a load that is still current. A cancelled load
   * never reports one. Without it a failure keeps what the caller already shows.
   */
  onError?: (error: unknown) => void;
  /** Runs after `onSuccess` or `onError`, only for a load that is still current. */
  onSettled?: () => void;
};

export type LoadOptions = {
  /** Waits this long before loading, as a debounce or a poll interval. Cancelling during the wait sends nothing. */
  delayMs?: number;
};

export type Load<T> = (signal: AbortSignal) => Promise<T>;

/**
 * The loads and listeners of one effect, such as a refresh that repeats on an
 * event or a timer. Everything it started stays current until `cancel`.
 */
export type EffectScope = {
  /** Aborts once the scope is cancelled; listeners check it before acting on an event. */
  readonly signal: AbortSignal;
  /**
   * Starts a load. The promise resolves once the load has settled and its
   * handlers ran, or once it was dropped; it never rejects with the load's failure.
   */
  load<T>(load: Load<T>, handlers?: LoadHandlers<T>, options?: LoadOptions): Promise<void>;
  /**
   * Holds a listener that registers asynchronously, such as a native plugin's.
   * Cancelling removes it, including one that finishes registering afterwards.
   * Without `onError` a listener that fails to register is left out.
   */
  listen<H>(register: () => Promise<H>, remove: (handle: H) => void, onError?: (error: unknown) => void): void;
  cancel(): void;
};

export function createEffectScope(): EffectScope {
  const controller = new AbortController();
  const { signal } = controller;
  const whenCancelled = (release: () => void) => signal.addEventListener("abort", release, { once: true });
  return {
    signal,
    load<T>(load: Load<T>, handlers: LoadHandlers<T> = {}, { delayMs }: LoadOptions = {}) {
      if (signal.aborted) return Promise.resolve();
      const settle = (report: () => void) => {
        if (signal.aborted) return;
        report();
        handlers.onSettled?.();
      };
      const start = () => {
        if (signal.aborted) return Promise.resolve();
        let pending: Promise<T>;
        try {
          pending = load(signal);
        } catch (error) {
          pending = Promise.reject(error);
        }
        return pending.then(
          (value) => settle(() => handlers.onSuccess?.(value)),
          (error: unknown) => settle(() => handlers.onError?.(error)),
        );
      };
      if (delayMs === undefined) return start();
      return new Promise<void>((resolve) => {
        // A poll schedules a wait per round, so a finished wait stops listening.
        const clear = () => {
          globalThis.clearTimeout(timer);
          resolve();
        };
        const timer = globalThis.setTimeout(() => {
          signal.removeEventListener("abort", clear);
          resolve(start());
        }, delayMs);
        whenCancelled(clear);
      });
    },
    listen<H>(register: () => Promise<H>, remove: (handle: H) => void, onError?: (error: unknown) => void) {
      if (signal.aborted) return;
      let pending: Promise<H>;
      try {
        pending = register();
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then(
        (handle) => {
          if (signal.aborted) remove(handle);
          else whenCancelled(() => remove(handle));
        },
        (error: unknown) => {
          if (!signal.aborted) onError?.(error);
        },
      );
    },
    cancel: () => controller.abort(),
  };
}

/** Starts one load and returns the function that cancels it. */
export function startLoad<T>(load: Load<T>, handlers?: LoadHandlers<T>, options?: LoadOptions): () => void {
  const scope = createEffectScope();
  scope.load(load, handlers, options);
  return scope.cancel;
}

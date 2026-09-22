import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a callback whose identity never changes but always runs the latest
 * `callback`, so memoized children do not re-render when a parent recreates its
 * handlers. Call it from events or effects, never during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

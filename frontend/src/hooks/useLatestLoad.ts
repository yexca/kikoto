import { useCallback, useEffect, useMemo, useRef } from "react";

import { createEffectScope, type Load, type LoadHandlers } from "@/lib/effectScope";

/**
 * Runs a load that several triggers start, such as mounting, a poll, and a
 * refresh after an action. Only the latest load reports: starting another,
 * `cancel`, or unmounting cancels the one in flight. `run` resolves once its
 * load has settled, whether or not it still reported, so an action can await
 * the refresh it starts.
 */
export function useLatestLoad() {
  const cancelCurrent = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    cancelCurrent.current?.();
    cancelCurrent.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(<T>(load: Load<T>, handlers?: LoadHandlers<T>) => {
    cancelCurrent.current?.();
    const scope = createEffectScope();
    cancelCurrent.current = scope.cancel;
    return scope.load(load, handlers);
  }, []);
  return useMemo(() => ({ run, cancel }), [cancel, run]);
}

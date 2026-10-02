import { useCallback, useLayoutEffect, useRef } from "react";

import { useStableCallback } from "@/hooks/useStableCallback";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** Rehydrate retained lists before their effects can write or fetch stale controls. */
export function useBrowseHistoryState<State>({
  active,
  stateKey,
  read,
  keyOf,
  restore,
  isCurrentLocation,
}: {
  active: boolean;
  stateKey: string;
  read: () => State;
  keyOf: (state: State) => string;
  restore: (state: State) => void;
  isCurrentLocation: () => boolean;
}) {
  const pendingKey = useRef<string | null>(null);
  const readState = useStableCallback(read);
  const keyForState = useStableCallback(keyOf);
  const restoreState = useStableCallback(restore);
  const isCurrent = useStableCallback(isCurrentLocation);
  const currentKey = useStableCallback(() => stateKey);

  useLayoutEffect(() => {
    if (!active) return;
    const sync = () => {
      if (!isCurrent()) return;
      const state = readState();
      pendingKey.current = keyForState(state);
      restoreState(state);
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, [active, isCurrent, keyForState, readState, restoreState]);

  useLayoutEffect(() => {
    if (pendingKey.current === stateKey) pendingKey.current = null;
  });

  return useCallback(() => pendingKey.current !== null && pendingKey.current !== currentKey(), [currentKey]);
}

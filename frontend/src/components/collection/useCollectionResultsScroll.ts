import { useCallback, useEffect, useRef } from "react";

import { startResultsScroll, type PendingResultsScroll } from "@/components/collection/collectionResultsScroll";

/**
 * Returns a collection to the start of its results after a page change. `queue`
 * marks the change, `complete` applies the scroll once the new results are set,
 * and `cancel` drops it when they fail to load. `anchorRef` marks where the
 * results start on desktop layouts.
 */
export function useCollectionResultsScroll<Anchor extends HTMLElement = HTMLDivElement>() {
  const anchorRef = useRef<Anchor | null>(null);
  const pendingResultsScroll = useRef<PendingResultsScroll | null>(null);

  const cancel = useCallback(() => {
    pendingResultsScroll.current?.cancel();
    pendingResultsScroll.current = null;
  }, []);
  useEffect(() => () => pendingResultsScroll.current?.cancel(), []);

  const complete = useCallback(() => {
    const pending = pendingResultsScroll.current;
    pendingResultsScroll.current = null;
    pending?.complete(() => anchorRef.current);
  }, []);

  const queue = useCallback(() => {
    cancel();
    pendingResultsScroll.current = startResultsScroll();
  }, [cancel]);

  return { anchorRef, queue, complete, cancel };
}

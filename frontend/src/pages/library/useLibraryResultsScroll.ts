import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { startResultsScroll, type PendingResultsScroll } from "@/components/collection/collectionResultsScroll";
import { restoreCurrentHistoryScroll } from "@/lib/browserHistory";

/**
 * Scroll position of the Library results. A control change returns to the
 * start of the new results once they render; a restored browse state reapplies
 * its saved offset instead. `visible` is whether the list is the surface on
 * screen.
 */
export function useLibraryResultsScroll(visible: boolean) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const pendingResultsScroll = useRef<PendingResultsScroll | null>(null);
  const pendingScrollRestore = useRef<number | null>(null);

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

  useLayoutEffect(() => {
    if (!visible) return;
    const scrollY = pendingScrollRestore.current;
    if (scrollY === null) return;

    pendingScrollRestore.current = null;
    restoreCurrentHistoryScroll(scrollY);
  });

  /** Scrolls to the start of the results when the next ones render. */
  const queue = useCallback(() => {
    pendingScrollRestore.current = null;
    cancel();
    pendingResultsScroll.current = startResultsScroll();
  }, [cancel]);

  /** Reapplies a saved offset once the list renders. */
  const restore = useCallback(
    (scrollY: number) => {
      pendingScrollRestore.current = scrollY;
      cancel();
    },
    [cancel],
  );

  return { anchorRef, queue, complete, cancel, restore };
}

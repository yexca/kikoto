import { useCallback, useLayoutEffect, useRef } from "react";

import { useCollectionResultsScroll } from "@/components/collection/useCollectionResultsScroll";
import { restoreCurrentHistoryScroll } from "@/lib/browserHistory";

/**
 * Scroll position of the Library results. A control change returns to the
 * start of the new results once they render; a restored browse state reapplies
 * its saved offset instead. `visible` is whether the list is the surface on
 * screen.
 */
export function useLibraryResultsScroll(visible: boolean) {
  const { anchorRef, queue: queueResults, complete, cancel } = useCollectionResultsScroll();
  const pendingScrollRestore = useRef<number | null>(null);

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
    queueResults();
  }, [queueResults]);

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

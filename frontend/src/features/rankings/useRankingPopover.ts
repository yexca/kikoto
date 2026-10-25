import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Open state for a toolbar popover that keyboard users can work in: opening
 * moves focus to its preferred control, and closing it from inside returns
 * focus to the button that opened it.
 */
export function useRankingPopover(focusSelector: string) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpenState] = useState(false);

  useEffect(() => {
    if (!open) return;
    // The popover becomes visible once its first layout pass has placed it.
    const frame = window.requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLElement>(focusSelector)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSelector, open]);

  const setOpen = useCallback((next: boolean) => {
    if (!next && contentRef.current?.contains(document.activeElement))
      anchorRef.current?.focus({ preventScroll: true });
    setOpenState(next);
  }, []);

  return { anchorRef, contentRef, open, setOpen };
}

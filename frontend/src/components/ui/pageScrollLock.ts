type ScrollLockRoot = {
  clientWidth: number;
  style: {
    overflow: string;
    getPropertyValue(property: string): string;
    setProperty(property: string, value: string): void;
    removeProperty(property: string): string;
  };
};

let lockCount = 0;
let restore: (() => void) | null = null;

/**
 * Keeps the page behind a modal from scrolling. The first lock hides the
 * document's overflow, and the last release restores the previous styles, so
 * nested dialogs share one lock. A visible classic scrollbar keeps its gutter
 * so the page does not shift sideways while locked.
 */
export function lockPageScroll(root: ScrollLockRoot, viewportWidth: number) {
  lockCount += 1;
  if (lockCount === 1) {
    const previousOverflow = root.style.overflow;
    const previousGutter = root.style.getPropertyValue("scrollbar-gutter");
    if (viewportWidth > root.clientWidth) root.style.setProperty("scrollbar-gutter", "stable");
    root.style.overflow = "hidden";
    restore = () => {
      root.style.overflow = previousOverflow;
      if (previousGutter) root.style.setProperty("scrollbar-gutter", previousGutter);
      else root.style.removeProperty("scrollbar-gutter");
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount === 0) {
      restore?.();
      restore = null;
    }
  };
}

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { lockPageScroll } from "@/components/ui/pageScrollLock";

/**
 * A full-screen dark layer for a video player or photo viewer. It is a modal
 * dialog, so Escape and the native back gesture close it, the page
 * behind it does not scroll, and focus returns to the tile that opened it.
 * The stage stays dark in every theme, so its controls use the dark tokens.
 */
export function MediaOverlay({
  label,
  onClose,
  onKeyDown,
  children,
}: {
  label: string;
  onClose: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => lockPageScroll(document.documentElement, window.innerWidth), []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A fullscreen video leaves fullscreen first; the browser handles that Escape.
      if (document.fullscreenElement) return;
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="dark fixed inset-0 z-overlay flex flex-col bg-black pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] pr-[var(--safe-area-right)] pt-[var(--safe-area-top)] text-foreground outline-none duration-150 animate-in fade-in-0"
    >
      {children}
    </div>
  );
}

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/tailwindClassNames";

const mobileSheetTransitionMs = 200;

type MobileSheetDrag = {
  pointerId: number;
  startedAt: number;
  startY: number;
};

export function MobileSheetHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-mobile-sheet-header
      className={cn("flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4", className)}
    >
      {children}
    </div>
  );
}

export function MobileSheetBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-mobile-sheet-body className={cn("app-scroll min-h-0 flex-1 overflow-auto p-2", className)}>
      {children}
    </div>
  );
}

export function MobileSheet({
  open,
  onOpenChange,
  ariaLabel,
  ariaLabelledby,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel?: string;
  ariaLabelledby?: string;
  children: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragRef = useRef<MobileSheetDrag | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let timer = 0;
    dragRef.current = null;
    if (open) {
      setMounted(true);
      setDragging(false);
      setDragOffset(0);
      frame = window.requestAnimationFrame(() => setEntered(true));
    } else {
      setEntered(false);
      setDragging(false);
      setDragOffset(0);
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
      timer = window.setTimeout(() => setMounted(false), reducedMotion ? 0 : mobileSheetTransitionMs);
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", dismissWithEscape);
    return () => window.removeEventListener("keydown", dismissWithEscape);
  }, [onOpenChange, open]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!open || (event.pointerType === "mouse" && event.button !== 0)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startedAt: performance.now(),
      startY: event.clientY,
    };
    setDragging(true);
    setDragOffset(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setDragOffset(Math.max(0, event.clientY - drag.startY));
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const offset = Math.max(0, event.clientY - drag.startY);
    const elapsed = Math.max(1, performance.now() - drag.startedAt);
    const velocity = offset / elapsed;
    const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
    const distanceThreshold = Math.min(160, Math.max(80, panelHeight * 0.2));
    const shouldClose = !cancelled && (offset >= distanceThreshold || (offset >= 32 && velocity >= 0.65));
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (shouldClose) onOpenChange(false);
    else setDragOffset(0);
  };

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="visual-viewport-layer z-[70] flex items-end bg-transparent p-2 sm:p-4"
      onPointerDown={(event) => {
        if (open && event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        data-mobile-sheet
        data-state={entered ? "open" : "closed"}
        data-android-back-close
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        className={cn(
          "theme-floating-surface app-scroll min-h-0 w-full overflow-y-auto rounded-t-xl border bg-card shadow-xl transition-transform duration-200 ease-out will-change-transform motion-reduce:transition-none",
          entered ? "translate-y-0" : "translate-y-full",
          dragging && "transition-none",
          className,
        )}
        style={{
          maxHeight: "calc(var(--visual-viewport-height) - 1rem)",
          paddingBottom: "max(0.5rem, var(--safe-area-bottom))",
          transform: dragOffset > 0 ? `translate3d(0, ${dragOffset}px, 0)` : undefined,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div
          data-mobile-sheet-handle
          className="sticky top-0 z-10 flex h-6 w-full shrink-0 touch-none cursor-grab items-center justify-center bg-card active:cursor-grabbing"
          aria-hidden="true"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event)}
          onPointerCancel={(event) => finishDrag(event, true)}
          onLostPointerCapture={() => {
            if (!dragRef.current) return;
            dragRef.current = null;
            setDragging(false);
            setDragOffset(0);
          }}
        >
          <div className="h-1 w-10 rounded-full bg-muted-foreground/35" />
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

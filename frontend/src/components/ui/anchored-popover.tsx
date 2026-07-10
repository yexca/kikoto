import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type PopoverPosition = { left: number; top: number; visible: boolean };

export function AnchoredPopover({
  open,
  anchorRef,
  children,
  className,
  gap = 8,
  collisionPadding = 12,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  gap?: number;
  collisionPadding?: number;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, visible: false });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const availableBelow = window.innerHeight - collisionPadding - anchorRect.bottom - gap;
    const availableAbove = anchorRect.top - collisionPadding - gap;
    const openBelow = availableBelow >= contentRect.height || availableBelow >= availableAbove;
    const desiredTop = openBelow ? anchorRect.bottom + gap : anchorRect.top - contentRect.height - gap;
    const maxLeft = Math.max(collisionPadding, window.innerWidth - contentRect.width - collisionPadding);
    const maxTop = Math.max(collisionPadding, window.innerHeight - contentRect.height - collisionPadding);
    setPosition({
      left: Math.max(collisionPadding, Math.min(maxLeft, anchorRect.right - contentRect.width)),
      top: Math.max(collisionPadding, Math.min(maxTop, desiredTop)),
      visible: true,
    });
  }, [anchorRef, collisionPadding, gap]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) => ({ ...current, visible: false }));
      return;
    }
    updatePosition();
    const content = contentRef.current;
    const observer = typeof ResizeObserver === "undefined" || !content ? null : new ResizeObserver(updatePosition);
    if (observer && content) observer.observe(content);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  if (!open) return null;
  return createPortal(
    <div
      ref={contentRef}
      className={cn("fixed z-50 max-h-[calc(100dvh-1.5rem)] overflow-y-auto", className)}
      style={{ left: position.left, top: position.top, visibility: position.visible ? "visible" : "hidden" }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

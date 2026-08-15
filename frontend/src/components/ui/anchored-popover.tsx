import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

type PopoverPosition = { left: number; top: number; maxHeight: number; visible: boolean };

export function AnchoredPopover({
  open,
  anchorRef,
  children,
  className,
  align = "end",
  gap = 8,
  collisionPadding = 12,
  bottomCollisionPadding = collisionPadding,
  zIndex,
  ariaLabel,
  onOpenChange,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  gap?: number;
  collisionPadding?: number;
  bottomCollisionPadding?: number;
  zIndex?: number;
  ariaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, maxHeight: 0, visible: false });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportBottom = viewportTop + viewportHeight;
    const availableBelow = viewportBottom - bottomCollisionPadding - anchorRect.bottom - gap;
    const availableAbove = anchorRect.top - viewportTop - collisionPadding - gap;
    const openBelow = availableBelow >= contentRect.height || availableBelow >= availableAbove;
    const desiredTop = openBelow ? anchorRect.bottom + gap : anchorRect.top - contentRect.height - gap;
    const desiredLeft = align === "start" ? anchorRect.left : anchorRect.right - contentRect.width;
    const minLeft = viewportLeft + collisionPadding;
    const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - contentRect.width - collisionPadding);
    const minTop = viewportTop + collisionPadding;
    const maxTop = Math.max(minTop, viewportBottom - contentRect.height - bottomCollisionPadding);
    const availableHeight = Math.max(8, openBelow ? availableBelow : availableAbove);
    setPosition({
      left: Math.max(minLeft, Math.min(maxLeft, desiredLeft)),
      top: Math.max(minTop, Math.min(maxTop, desiredTop)),
      maxHeight: availableHeight,
      visible: true,
    });
  }, [align, anchorRef, bottomCollisionPadding, collisionPadding, gap]);

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
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [open, updatePosition]);

  useLayoutEffect(() => {
    if (!open || !onOpenChange) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || contentRef.current?.contains(target))) return;
      onOpenChange(false);
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [anchorRef, onOpenChange, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={contentRef}
      data-android-back-close
      role={ariaLabel ? "dialog" : undefined}
      aria-label={ariaLabel}
      className={cn(
        "theme-floating-surface app-scrollbar fixed z-50 max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-xl",
        className,
      )}
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight > 0 ? position.maxHeight : undefined,
        visibility: position.visible ? "visible" : "hidden",
        zIndex,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

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
	bottomCollisionPadding = collisionPadding,
	zIndex,
	onOpenChange,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  gap?: number;
  collisionPadding?: number;
	bottomCollisionPadding?: number;
	zIndex?: number;
	onOpenChange?: (open: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<PopoverPosition>({ left: 0, top: 0, visible: false });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const content = contentRef.current;
    if (!anchor || !content) return;
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
	const availableBelow = window.innerHeight - bottomCollisionPadding - anchorRect.bottom - gap;
    const availableAbove = anchorRect.top - collisionPadding - gap;
    const openBelow = availableBelow >= contentRect.height || availableBelow >= availableAbove;
    const desiredTop = openBelow ? anchorRect.bottom + gap : anchorRect.top - contentRect.height - gap;
    const maxLeft = Math.max(collisionPadding, window.innerWidth - contentRect.width - collisionPadding);
	const maxTop = Math.max(collisionPadding, window.innerHeight - contentRect.height - bottomCollisionPadding);
    setPosition({
      left: Math.max(collisionPadding, Math.min(maxLeft, anchorRect.right - contentRect.width)),
      top: Math.max(collisionPadding, Math.min(maxTop, desiredTop)),
      visible: true,
    });
	}, [anchorRef, bottomCollisionPadding, collisionPadding, gap]);

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
		className={cn("app-scroll fixed z-50 max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-xl", className)}
      style={{ left: position.left, top: position.top, visibility: position.visible ? "visible" : "hidden", zIndex }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

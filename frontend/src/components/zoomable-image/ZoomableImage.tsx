import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useStableCallback } from "@/hooks/useStableCallback";
import { cn } from "@/lib/tailwindClassNames";

import {
  clampImageZoom,
  imageClickZoom,
  imageZoomScale,
  imageZoomStep,
  type ImageZoom,
  wheelZoomFactor,
} from "./imageZoomModel";

/** A point on the screen and the fraction of the image under it, which a zoom keeps under that point. */
type ZoomAnchor = { fx: number; fy: number; px: number; py: number };
type PanGesture = { pointerId: number; x: number; y: number; left: number; top: number; moved: boolean };
type PinchGesture = { distance: number; scale: number; fx: number; fy: number };

/** A horizontal touch swipe on the fitted image longer than this steps to a neighbour. */
const swipeThresholdPx = 48;

function midpoint(points: Iterable<{ x: number; y: number }>) {
  const [a, b] = [...points];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) };
}

/**
 * A full-stage image that fits the stage until it is zoomed by click, wheel,
 * trackpad or touch pinch, or the `+`, `-` and `0` keys while focus is in its
 * dialog, and pans by dragging. A horizontal touch swipe on the fitted image
 * calls `onSwipe` with 1 for the next image and -1 for the previous one.
 */
export function ZoomableImage({
  src,
  alt,
  zoom,
  onZoomChange,
  onSwipe,
  onLoad,
  onError,
  className,
  fitClassName,
  imageClassName,
}: {
  src: string | undefined;
  alt: string;
  zoom: ImageZoom;
  onZoomChange: (zoom: ImageZoom) => void;
  onSwipe?: (direction: 1 | -1) => void;
  onLoad?: (image: HTMLImageElement) => void;
  onError?: () => void;
  /** Classes for the scrolling stage. */
  className?: string;
  /** Classes the stage has only while the image is fitted, such as its padding. */
  fitClassName?: string;
  imageClassName?: string;
}) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  // The scale that fits the image in the stage, measured whenever it is shown fitted.
  const fitScaleRef = useRef(1);
  // The zoom last requested, so wheel and pinch events that arrive before a render build on each other.
  const zoomRef = useRef(zoom);
  const touchesRef = useRef(new Map<number, { x: number; y: number }>());
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const pinchRef = useRef<PinchGesture | null>(null);
  const suppressClickRef = useRef(false);
  const zoomed = zoom !== "fit";

  const measureFit = useCallback(() => {
    const image = imageRef.current;
    if (zoomRef.current !== "fit" || !image?.naturalWidth || !image.clientWidth) return;
    fitScaleRef.current = Math.min(1, image.clientWidth / image.naturalWidth);
  }, []);

  /** Scrolls so the anchored fraction of the image sits under the anchored screen point. */
  const alignAnchor = useCallback((anchor: ZoomAnchor | null) => {
    const container = scrollRef.current;
    const image = imageRef.current;
    if (!container || !image) return;
    const stage = container.getBoundingClientRect();
    const target = anchor ?? { fx: 0.5, fy: 0.5, px: stage.left + stage.width / 2, py: stage.top + stage.height / 2 };
    const bounds = image.getBoundingClientRect();
    container.scrollLeft += bounds.left + target.fx * bounds.width - target.px;
    container.scrollTop += bounds.top + target.fy * bounds.height - target.py;
  }, []);

  useLayoutEffect(() => {
    zoomRef.current = zoom;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (zoom === "fit") measureFit();
    else alignAnchor(anchor);
  }, [zoom, measureFit, alignAnchor]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureFit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureFit]);

  const anchorAt = (px: number, py: number): ZoomAnchor => {
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return { fx: 0.5, fy: 0.5, px, py };
    return {
      fx: Math.min(1, Math.max(0, (px - bounds.left) / bounds.width)),
      fy: Math.min(1, Math.max(0, (py - bounds.top) / bounds.height)),
      px,
      py,
    };
  };

  const currentScale = () => {
    measureFit();
    return imageZoomScale(zoomRef.current, fitScaleRef.current);
  };

  const applyZoom = (scale: number, anchor: ZoomAnchor) => {
    if (!imageRef.current?.naturalWidth) return;
    measureFit();
    const next = clampImageZoom(scale, fitScaleRef.current);
    if (next === zoomRef.current) {
      // A pinch that only moves keeps panning the image under the fingers.
      if (next !== "fit") alignAnchor(anchor);
      return;
    }
    zoomRef.current = next;
    anchorRef.current = anchor;
    onZoomChange(next);
  };

  const zoomBy = useStableCallback((factor: number, px: number, py: number) =>
    applyZoom(currentScale() * factor, anchorAt(px, py)),
  );

  const startPan = (container: HTMLElement, pointerId: number, x: number, y: number) => {
    panRef.current = { pointerId, x, y, left: container.scrollLeft, top: container.scrollTop, moved: false };
  };

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      // A sideways trackpad scroll pans; the wheel and trackpad pinches (ctrl+wheel) zoom.
      if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey), event.clientX, event.clientY);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, [zoomBy]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const factor =
        event.key === "+" || event.key === "="
          ? imageZoomStep
          : event.key === "-"
            ? 1 / imageZoomStep
            : event.key === "0"
              ? 0
              : null;
      if (factor === null) return;
      const container = scrollRef.current;
      const dialog = container?.closest("[role='dialog']");
      const active = document.activeElement;
      if (!container || !dialog || !(active instanceof HTMLElement) || !dialog.contains(active)) return;
      if (active.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      const stage = container.getBoundingClientRect();
      zoomBy(factor, stage.left + stage.width / 2, stage.top + stage.height / 2);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomBy]);

  return (
    <div
      ref={scrollRef}
      className={cn("app-scroll min-h-0", zoomed ? "overflow-auto" : cn("overflow-hidden", fitClassName), className)}
      style={{ touchAction: "none" }}
      onPointerDown={(event) => {
        const touches = touchesRef.current;
        if (event.pointerType === "mouse") {
          suppressClickRef.current = false;
          if (zoomRef.current !== "fit" && event.button === 0) {
            startPan(event.currentTarget, event.pointerId, event.clientX, event.clientY);
          }
          return;
        }
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 1) {
          suppressClickRef.current = false;
          if (zoomRef.current !== "fit") {
            startPan(event.currentTarget, event.pointerId, event.clientX, event.clientY);
          } else {
            swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          }
          return;
        }
        if (touches.size === 2) {
          // A second finger turns the swipe or pan into a pinch around the fingers' midpoint.
          swipeRef.current = null;
          panRef.current = null;
          suppressClickRef.current = true;
          const middle = midpoint(touches.values());
          const anchor = anchorAt(middle.x, middle.y);
          pinchRef.current = { distance: middle.distance, scale: currentScale(), fx: anchor.fx, fy: anchor.fy };
        }
      }}
      onPointerMove={(event) => {
        const touches = touchesRef.current;
        if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const pinch = pinchRef.current;
        if (pinch) {
          if (touches.size < 2) return;
          const middle = midpoint(touches.values());
          applyZoom((pinch.scale * middle.distance) / pinch.distance, {
            fx: pinch.fx,
            fy: pinch.fy,
            px: middle.x,
            py: middle.y,
          });
          return;
        }
        const pan = panRef.current;
        if (!pan || pan.pointerId !== event.pointerId) return;
        const dx = event.clientX - pan.x;
        const dy = event.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) < 4) return;
        pan.moved = true;
        event.currentTarget.scrollLeft = pan.left - dx;
        event.currentTarget.scrollTop = pan.top - dy;
      }}
      onPointerUp={(event) => {
        const touches = touchesRef.current;
        touches.delete(event.pointerId);
        if (pinchRef.current) {
          if (touches.size >= 2) return;
          pinchRef.current = null;
          // The finger still down carries on panning the zoomed image.
          const [rest] = touches.entries();
          if (rest && zoomRef.current !== "fit") startPan(event.currentTarget, rest[0], rest[1].x, rest[1].y);
          return;
        }
        const pan = panRef.current;
        panRef.current = null;
        // A drag that panned the image must not also zoom it out.
        if (pan?.moved) suppressClickRef.current = true;
        const swipe = swipeRef.current;
        swipeRef.current = null;
        if (!swipe || swipe.pointerId !== event.pointerId || !onSwipe) return;
        const dx = event.clientX - swipe.x;
        const dy = event.clientY - swipe.y;
        if (Math.abs(dx) >= swipeThresholdPx && Math.abs(dx) > Math.abs(dy) * 1.5) {
          suppressClickRef.current = true;
          onSwipe(dx < 0 ? 1 : -1);
        }
      }}
      onPointerCancel={(event) => {
        touchesRef.current.delete(event.pointerId);
        pinchRef.current = null;
        panRef.current = null;
        swipeRef.current = null;
      }}
    >
      <div className={cn("flex items-center justify-center", zoomed ? "min-h-full min-w-full w-max" : "h-full w-full")}>
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          decoding="async"
          draggable={false}
          style={
            typeof zoom === "number" && natural
              ? { width: natural.width * zoom, height: natural.height * zoom }
              : undefined
          }
          className={cn(
            "select-none",
            zoomed
              ? "max-w-none shrink-0 cursor-grab active:cursor-grabbing"
              : "max-h-full max-w-full cursor-zoom-in object-contain",
            imageClassName,
          )}
          onLoad={(event) => {
            const image = event.currentTarget;
            setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            measureFit();
            onLoad?.(image);
          }}
          onError={onError}
          onClick={(event) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            if (zoomRef.current === "fit") {
              applyZoom(imageClickZoom(currentScale()), anchorAt(event.clientX, event.clientY));
            } else {
              zoomRef.current = "fit";
              anchorRef.current = null;
              onZoomChange("fit");
            }
          }}
        />
      </div>
    </div>
  );
}

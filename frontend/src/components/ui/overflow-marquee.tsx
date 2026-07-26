import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

type MarqueeStyle = CSSProperties & {
  "--marquee-distance"?: string;
  "--marquee-duration"?: string;
};

const MARQUEE_GAP_PX = 32;
const MARQUEE_SPEED_PX_PER_SECOND = 32;
const MARQUEE_ORIGIN_PAUSE_MS = 2500;

export function OverflowMarquee({
  text,
  className,
  interactionOnly = false,
}: {
  text: string;
  className?: string;
  interactionOnly?: boolean;
}) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const [marqueeDistance, setMarqueeDistance] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      const contentWidth = Math.ceil(content.scrollWidth);
      const nextDistance = contentWidth > container.clientWidth ? contentWidth + MARQUEE_GAP_PX : 0;
      setMarqueeDistance((currentDistance) => currentDistance === nextDistance ? currentDistance : nextDistance);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (containerRef.current) observer?.observe(containerRef.current);
    if (contentRef.current) observer?.observe(contentRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  const overflowing = marqueeDistance > 0;
  const style: MarqueeStyle | undefined = overflowing ? {
    "--marquee-distance": `${marqueeDistance}px`,
    "--marquee-duration": `${(marqueeDistance / MARQUEE_SPEED_PX_PER_SECOND).toFixed(2)}s`,
  } : undefined;

  return (
    <span
      ref={containerRef}
      className={cn(
        "overflow-marquee block min-w-0 overflow-hidden whitespace-nowrap",
        overflowing && (interactionOnly ? "overflow-marquee--interaction" : "overflow-marquee--auto"),
        className,
      )}
      title={overflowing ? text : undefined}
    >
      <span className="overflow-marquee__track inline-flex min-w-max gap-[32px]" style={style}>
        <span ref={contentRef} className="overflow-marquee__copy inline-block min-w-max">
          {text}
        </span>
        {overflowing && (
          <span className="overflow-marquee__copy inline-block min-w-max" aria-hidden="true">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}

export function OverflowMarqueeGroup({
  primaryText,
  secondaryText,
  className,
  primaryClassName,
  secondaryClassName,
}: {
  primaryText: string;
  secondaryText: string;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
}) {
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const [marqueeDistance, setMarqueeDistance] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      const contentWidth = Math.ceil(content.scrollWidth);
      const nextDistance = contentWidth > container.clientWidth ? contentWidth + MARQUEE_GAP_PX : 0;
      setMarqueeDistance((currentDistance) => currentDistance === nextDistance ? currentDistance : nextDistance);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (containerRef.current) observer?.observe(containerRef.current);
    if (contentRef.current) observer?.observe(contentRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [primaryText, secondaryText]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || marqueeDistance <= 0 || typeof track.animate !== "function") return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | null = null;
    const syncAnimation = () => {
      animation?.cancel();
      animation = null;
      if (reducedMotion.matches) return;
      const travelDurationMs = (marqueeDistance / MARQUEE_SPEED_PX_PER_SECOND) * 1000;
      const totalDurationMs = MARQUEE_ORIGIN_PAUSE_MS + travelDurationMs;
      const pauseOffset = MARQUEE_ORIGIN_PAUSE_MS / totalDurationMs;
      animation = track.animate([
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: pauseOffset },
        { transform: `translateX(-${marqueeDistance}px)`, offset: 1 },
      ], {
        duration: totalDurationMs,
        easing: "linear",
        iterations: Infinity,
      });
    };
    syncAnimation();
    reducedMotion.addEventListener("change", syncAnimation);
    return () => {
      reducedMotion.removeEventListener("change", syncAnimation);
      animation?.cancel();
    };
  }, [marqueeDistance]);

  const overflowing = marqueeDistance > 0;
  return (
    <span
      ref={containerRef}
      className={cn("overflow-marquee-group block min-w-0 overflow-hidden", className)}
      title={overflowing ? `${primaryText}\n${secondaryText}` : undefined}
    >
      <span
        ref={trackRef}
        className={cn("overflow-marquee-group__track inline-flex min-w-max gap-[32px]", overflowing && "will-change-transform")}
        data-marquee-pause-ms={overflowing ? MARQUEE_ORIGIN_PAUSE_MS : undefined}
      >
        <span ref={contentRef} className="overflow-marquee-group__copy grid min-w-max">
          <span className={cn("block min-w-max whitespace-nowrap", primaryClassName)}>{primaryText}</span>
          <span className={cn("block min-w-max whitespace-nowrap", secondaryClassName)}>{secondaryText}</span>
        </span>
        {overflowing && (
          <span className="overflow-marquee-group__copy grid min-w-max" aria-hidden="true">
            <span className={cn("block min-w-max whitespace-nowrap", primaryClassName)}>{primaryText}</span>
            <span className={cn("block min-w-max whitespace-nowrap", secondaryClassName)}>{secondaryText}</span>
          </span>
        )}
      </span>
    </span>
  );
}

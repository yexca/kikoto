import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

type MarqueeStyle = CSSProperties & {
  "--marquee-distance"?: string;
  "--marquee-duration"?: string;
};

const MARQUEE_GAP_PX = 32;
const MARQUEE_SPEED_PX_PER_SECOND = 32;

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

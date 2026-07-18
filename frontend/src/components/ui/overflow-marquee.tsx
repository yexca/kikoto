import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

type MarqueeStyle = CSSProperties & {
  "--marquee-distance"?: string;
  "--marquee-duration"?: string;
};

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
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      setOverflow(Math.max(0, Math.ceil(content.scrollWidth - container.clientWidth)));
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

  const style: MarqueeStyle | undefined = overflow > 0 ? {
    "--marquee-distance": `${overflow}px`,
    "--marquee-duration": `${Math.max(6, Math.min(24, overflow / 32 + 4))}s`,
  } : undefined;

  return (
    <span
      ref={containerRef}
      className={cn(
        "overflow-marquee block min-w-0 overflow-hidden whitespace-nowrap",
        overflow > 0 && (interactionOnly ? "overflow-marquee--interaction" : "overflow-marquee--auto"),
        className,
      )}
      title={overflow > 0 ? text : undefined}
    >
      <span ref={contentRef} className="overflow-marquee__content inline-block min-w-max" style={style}>
        {text}
      </span>
    </span>
  );
}

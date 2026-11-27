import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/tailwindClassNames";

import { MARQUEE_GAP_PX, MARQUEE_ORIGIN_PAUSE_MS, marqueeTimeline } from "./overflowMarqueeTiming";

export type OverflowMarqueeLine = {
  text: string;
  className?: string;
  /** Hover hint shown even when the line fits; otherwise an overflowing line hints its own text. */
  hint?: string;
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/**
 * Stacked single-line texts, such as a title over an artist. Only a line that
 * cannot fit scrolls; when several do, they share one cycle so they start
 * together. With reduced motion an overflowing line ends in an ellipsis.
 *
 * `running` false keeps every line at its start (an inactive queue row);
 * `paused` freezes a running cycle in place (a gesture on the bar).
 */
export function OverflowMarqueeLines({
  lines,
  className,
  running = true,
  paused = false,
}: {
  lines: OverflowMarqueeLine[];
  className?: string;
  running?: boolean;
  paused?: boolean;
}) {
  const lineRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const trackRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const animationsRef = useRef<Animation[]>([]);
  const [distances, setDistances] = useState<number[]>([]);
  const reducedMotion = usePrefersReducedMotion();
  // Callers rebuild the lines every render; key the effects on the texts themselves.
  const textsKey = JSON.stringify(lines.map((line) => line.text));
  const texts = useMemo(() => JSON.parse(textsKey) as string[], [textsKey]);
  // A class change, such as the bolder title of the playing queue row, widens
  // the text without resizing its line.
  const classesKey = JSON.stringify(lines.map((line) => line.className ?? ""));
  // A line that starts or stops scrolling swaps its text for the two copies.
  const scrollingKey = distances.map((distance) => distance > 0).join();
  const scrolls = !reducedMotion;

  useLayoutEffect(() => {
    const measure = () => {
      const next = texts.map((_, index) => {
        const line = lineRefs.current[index];
        if (!line) return 0;
        // A scrolling line holds two copies; its own text is the first.
        const copy = line.querySelector<HTMLElement>("[data-marquee-copy]");
        const textWidth = Math.ceil(copy ? copy.scrollWidth : line.scrollWidth);
        return textWidth > line.clientWidth ? textWidth + MARQUEE_GAP_PX : 0;
      });
      setDistances((current) =>
        current.length === next.length && current.every((value, index) => value === next[index]) ? current : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    texts.forEach((_, index) => {
      const line = lineRefs.current[index];
      if (!line) return;
      observer?.observe(line);
      // The copy is an inline block, so a change of its own width reports here.
      const copy = line.querySelector<HTMLElement>("[data-marquee-copy]");
      if (copy) observer?.observe(copy);
    });
    window.addEventListener("resize", measure);
    // A web font that finishes loading changes the text width but not the line box.
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [texts, classesKey, scrollingKey]);

  const timeline = useMemo(() => (scrolls ? marqueeTimeline(distances) : null), [scrolls, distances]);

  useEffect(() => {
    animationsRef.current = [];
    if (!timeline || !running) return;
    const animations: Animation[] = [];
    timeline.lines.forEach((frames, index) => {
      const track = trackRefs.current[index];
      if (!frames || !track || typeof track.animate !== "function") return;
      animations.push(track.animate(frames, { duration: timeline.durationMs, easing: "linear", iterations: Infinity }));
    });
    animationsRef.current = animations;
    return () => {
      for (const animation of animations) animation.cancel();
      animationsRef.current = [];
    };
    // A new text restarts the cycle from its start even at the same width.
  }, [timeline, running, texts]);

  useEffect(() => {
    for (const animation of animationsRef.current) {
      if (paused) animation.pause();
      else if (animation.playState === "paused") animation.play();
    }
  }, [paused, timeline, running, texts]);

  return (
    <span className={cn("block min-w-0", className)}>
      {lines.map((line, index) => {
        const overflowing = (distances[index] ?? 0) > 0;
        const scrolling = overflowing && scrolls;
        return (
          <span
            key={index}
            ref={(element) => {
              lineRefs.current[index] = element;
            }}
            className={cn(
              "block min-w-0 overflow-hidden whitespace-nowrap",
              !scrolling && "text-ellipsis",
              scrolling && "[mask-image:linear-gradient(to_right,#000_calc(100%-1rem),transparent)]",
              line.className,
            )}
            data-marquee={scrolling ? "auto" : "static"}
            title={line.hint ?? (overflowing ? line.text : undefined)}
          >
            {scrolling ? (
              <span
                ref={(element) => {
                  trackRefs.current[index] = element;
                }}
                className="inline-flex min-w-max will-change-transform"
                style={{ gap: `${MARQUEE_GAP_PX}px` }}
                data-marquee-track
                data-marquee-pause-ms={MARQUEE_ORIGIN_PAUSE_MS}
              >
                <span className="inline-block min-w-max" data-marquee-copy>
                  {line.text}
                </span>
                <span className="inline-block min-w-max" data-marquee-copy aria-hidden="true">
                  {line.text}
                </span>
              </span>
            ) : (
              line.text
            )}
          </span>
        );
      })}
    </span>
  );
}

/** Space between a scrolling line and its repeated copy. */
export const MARQUEE_GAP_PX = 32;
export const MARQUEE_SPEED_PX_PER_SECOND = 32;
/** How long every cycle rests on the start of the text before it moves. */
export const MARQUEE_ORIGIN_PAUSE_MS = 2500;

export type MarqueeLineKeyframe = { offset: number; transform: string };

export type MarqueeTimeline = {
  durationMs: number;
  /** One entry per line, in order; `null` for a line that does not scroll. */
  lines: (MarqueeLineKeyframe[] | null)[];
};

/**
 * One shared cycle for lines that scroll together. Every scrolling line rests
 * at its start, then travels its own distance at the same speed; a shorter line
 * waits at its start until the longest finishes, so all lines start each cycle
 * together. A distance of 0 or less means the line fits and stays still.
 */
export function marqueeTimeline(distances: readonly number[]): MarqueeTimeline | null {
  const longest = Math.max(0, ...distances);
  if (longest <= 0) return null;
  const travelMs = (distance: number) => (distance / MARQUEE_SPEED_PX_PER_SECOND) * 1000;
  const durationMs = MARQUEE_ORIGIN_PAUSE_MS + travelMs(longest);
  const pauseOffset = MARQUEE_ORIGIN_PAUSE_MS / durationMs;
  const lines = distances.map((distance) => {
    if (distance <= 0) return null;
    const arrivalOffset = Math.min(1, (MARQUEE_ORIGIN_PAUSE_MS + travelMs(distance)) / durationMs);
    const end = `translateX(-${distance}px)`;
    const frames: MarqueeLineKeyframe[] = [
      { offset: 0, transform: "translateX(0)" },
      { offset: pauseOffset, transform: "translateX(0)" },
      { offset: arrivalOffset, transform: end },
    ];
    // The repeated copy now sits where the text started, so holding here until
    // the cycle wraps looks the same as resting at the start.
    if (arrivalOffset < 1) frames.push({ offset: 1, transform: end });
    return frames;
  });
  return { durationMs, lines };
}

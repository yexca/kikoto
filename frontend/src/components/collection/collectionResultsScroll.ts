/** Layouts below the desktop breakpoint return to the page top instead of the results anchor. */
const COMPACT_LAYOUT_QUERY = "(max-width: 1023px)";
/** A scroll gesture or momentum is treated as finished after this long without a scroll event. */
export const RESULTS_SCROLL_SETTLE_MS = 150;
/** Upper bound on waiting for a continuous scroll to settle. */
export const RESULTS_SCROLL_MAX_WAIT_MS = 1500;

export type ResultsScrollEnvironment = {
  now(): number;
  compactLayout(): boolean;
  reducedMotion(): boolean;
  scrollToTop(): void;
  scrollAnchorIntoView(anchor: HTMLElement, behavior: ScrollBehavior): void;
  onScroll(listener: () => void): () => void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
};

export type PendingResultsScroll = {
  /** Applies the pending scroll once the new results have rendered. */
  complete(anchor: () => HTMLElement | null): void;
  cancel(): void;
};

/**
 * Starts tracking a requested return to the start of a collection's results.
 *
 * Compact layouts jump to the page top instead of animating: the list is
 * replaced wholesale, and WebKit abandons a long programmatic smooth scroll
 * when the replacement commits or when a touch scroll or its momentum is
 * still running, leaving the new page near where the old one was. The jump
 * also waits for such a scroll to settle so the gesture cannot override it.
 */
export function startResultsScroll(env: ResultsScrollEnvironment = browserResultsScrollEnvironment()) {
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let frame: number | null = null;
  let timer: number | null = null;
  let done = false;
  const stopListening = env.onScroll(() => {
    lastScrollAt = env.now();
  });

  const finish = () => {
    done = true;
    stopListening();
    if (frame !== null) env.cancelAnimationFrame(frame);
    if (timer !== null) env.clearTimeout(timer);
    frame = null;
    timer = null;
  };

  const pending: PendingResultsScroll = {
    complete(anchor) {
      if (done || frame !== null || timer !== null) return;
      const completedAt = env.now();
      const jumpWhenSettled = () => {
        timer = null;
        const now = env.now();
        const quietFor = now - lastScrollAt;
        if (quietFor < RESULTS_SCROLL_SETTLE_MS && now - completedAt < RESULTS_SCROLL_MAX_WAIT_MS) {
          timer = env.setTimeout(jumpWhenSettled, RESULTS_SCROLL_SETTLE_MS - quietFor);
          return;
        }
        finish();
        env.scrollToTop();
      };
      frame = env.requestAnimationFrame(() => {
        frame = null;
        if (env.compactLayout()) {
          jumpWhenSettled();
          return;
        }
        const element = anchor();
        finish();
        if (element) env.scrollAnchorIntoView(element, env.reducedMotion() ? "auto" : "smooth");
      });
    },
    cancel: finish,
  };
  return pending;
}

function browserResultsScrollEnvironment(): ResultsScrollEnvironment {
  return {
    now: () => performance.now(),
    compactLayout: () => window.matchMedia(COMPACT_LAYOUT_QUERY).matches,
    reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    scrollToTop: () => window.scrollTo({ top: 0, behavior: "instant" }),
    scrollAnchorIntoView: (anchor, behavior) => anchor.scrollIntoView({ behavior, block: "start" }),
    onScroll: (listener) => {
      window.addEventListener("scroll", listener, { passive: true });
      return () => window.removeEventListener("scroll", listener);
    },
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  };
}

import { describe, expect, it } from "vitest";

import {
  RESULTS_SCROLL_MAX_WAIT_MS,
  RESULTS_SCROLL_SETTLE_MS,
  startResultsScroll,
  type ResultsScrollEnvironment,
} from "@/components/collection/collectionResultsScroll";

function fakeEnvironment({ compact = true, reducedMotion = false } = {}) {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  const scrollListeners = new Set<() => void>();
  const calls: string[] = [];
  const env: ResultsScrollEnvironment = {
    now: () => now,
    compactLayout: () => compact,
    reducedMotion: () => reducedMotion,
    scrollToTop: () => calls.push("top"),
    scrollAnchorIntoView: (_anchor, behavior) => calls.push(`anchor:${behavior}`),
    onScroll: (listener) => {
      scrollListeners.add(listener);
      return () => scrollListeners.delete(listener);
    },
    setTimeout: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + delayMs, callback });
      return handle;
    },
    clearTimeout: (handle) => timers.delete(handle),
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: (handle) => frames.delete(handle),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = until;
  };
  return {
    env,
    calls,
    advance,
    renderFrame: () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    userScroll: () => scrollListeners.forEach((listener) => listener()),
    listenerCount: () => scrollListeners.size,
  };
}

const anchor = () => ({}) as HTMLElement;

describe("startResultsScroll", () => {
  it("jumps a compact layout to the top after the new results render", () => {
    const fake = fakeEnvironment();
    const pending = startResultsScroll(fake.env);

    pending.complete(anchor);
    expect(fake.calls).toEqual([]);
    fake.renderFrame();

    expect(fake.calls).toEqual(["top"]);
    expect(fake.listenerCount()).toBe(0);
  });

  it("waits for a scroll that is still running when the results arrive", () => {
    const fake = fakeEnvironment();
    const pending = startResultsScroll(fake.env);
    fake.advance(400);
    fake.userScroll();

    pending.complete(anchor);
    fake.renderFrame();
    expect(fake.calls).toEqual([]);

    // Momentum keeps producing scroll events; the jump must follow the last one.
    fake.advance(100);
    fake.userScroll();
    fake.advance(RESULTS_SCROLL_SETTLE_MS - 1);
    expect(fake.calls).toEqual([]);
    fake.advance(1);
    expect(fake.calls).toEqual(["top"]);
  });

  it("ignores a scroll that settled before the results arrived", () => {
    const fake = fakeEnvironment();
    const pending = startResultsScroll(fake.env);
    fake.userScroll();
    fake.advance(RESULTS_SCROLL_SETTLE_MS);

    pending.complete(anchor);
    fake.renderFrame();

    expect(fake.calls).toEqual(["top"]);
  });

  it("does not wait indefinitely for a continuous scroll", () => {
    const fake = fakeEnvironment();
    const pending = startResultsScroll(fake.env);
    fake.userScroll();
    pending.complete(anchor);
    fake.renderFrame();

    for (let elapsed = 0; elapsed < RESULTS_SCROLL_MAX_WAIT_MS; elapsed += 50) {
      fake.advance(50);
      fake.userScroll();
    }
    fake.advance(RESULTS_SCROLL_SETTLE_MS);

    expect(fake.calls).toEqual(["top"]);
  });

  it("brings a desktop results anchor into view with motion preferences respected", () => {
    const animated = fakeEnvironment({ compact: false });
    startResultsScroll(animated.env).complete(anchor);
    animated.renderFrame();
    expect(animated.calls).toEqual(["anchor:smooth"]);

    const reduced = fakeEnvironment({ compact: false, reducedMotion: true });
    startResultsScroll(reduced.env).complete(anchor);
    reduced.renderFrame();
    expect(reduced.calls).toEqual(["anchor:auto"]);
  });

  it("does nothing after it is cancelled", () => {
    const fake = fakeEnvironment();
    const pending = startResultsScroll(fake.env);
    pending.complete(anchor);
    pending.cancel();
    fake.renderFrame();
    fake.advance(RESULTS_SCROLL_MAX_WAIT_MS);

    expect(fake.calls).toEqual([]);
    expect(fake.listenerCount()).toBe(0);
  });
});

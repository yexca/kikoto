import { describe, expect, it } from "vitest";

import type { RecordProgress } from "@/lib/api";

import {
  RECORD_PROGRESS_SAVE_INTERVAL_MS,
  RecordProgressTracker,
  continueCandidate,
  createProgressLoader,
  resumePosition,
  watchedFraction,
} from "./recordProgress";

function trackerAt(initialPosition = 0) {
  let now = 1_000;
  const saved: RecordProgress[] = [];
  const tracker = new RecordProgressTracker(
    (progress) => saved.push(progress),
    initialPosition,
    () => now,
  );
  return {
    tracker,
    saved,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RecordProgressTracker", () => {
  it("saves about every ten seconds while playing", () => {
    const { tracker, saved, advance } = trackerAt();
    advance(4_000);
    tracker.timeUpdate(4, 120);
    expect(saved).toEqual([]);
    advance(RECORD_PROGRESS_SAVE_INTERVAL_MS - 4_000);
    tracker.timeUpdate(10, 120);
    expect(saved).toEqual([{ positionSeconds: 10, durationSeconds: 120, completed: false }]);
    advance(5_000);
    tracker.timeUpdate(15, 120);
    expect(saved).toHaveLength(1);
    advance(5_000);
    tracker.timeUpdate(20, 120);
    expect(saved[saved.length - 1]).toEqual({ positionSeconds: 20, durationSeconds: 120, completed: false });
  });

  it("saves on pause and when the player closes", () => {
    const { tracker, saved } = trackerAt();
    tracker.pause(33.5, 120);
    tracker.close(48, 120);
    expect(saved).toEqual([
      { positionSeconds: 33.5, durationSeconds: 120, completed: false },
      { positionSeconds: 48, durationSeconds: 120, completed: false },
    ]);
  });

  it("marks an ended video completed and does not overwrite it on close", () => {
    const { tracker, saved } = trackerAt(90);
    tracker.ended(120);
    tracker.close(120, 120);
    expect(saved).toEqual([{ positionSeconds: 120, durationSeconds: 120, completed: true }]);
  });

  it("does not write a video closed where it started", () => {
    const { tracker, saved } = trackerAt(42);
    tracker.pause(42.2, Number.NaN);
    tracker.close(42.4, Number.NaN);
    expect(saved).toEqual([]);
  });
});

describe("saved progress", () => {
  it("offers to continue only from the middle of an unfinished video", () => {
    expect(resumePosition(undefined)).toBeNull();
    expect(resumePosition({ positionSeconds: 3, completed: false })).toBeNull();
    expect(resumePosition({ positionSeconds: 83, durationSeconds: 300, completed: false })).toBe(83);
    expect(resumePosition({ positionSeconds: 298, durationSeconds: 300, completed: false })).toBeNull();
    expect(resumePosition({ positionSeconds: 150, durationSeconds: 300, completed: true })).toBeNull();
  });

  it("draws a tile bar only when the share is known", () => {
    expect(watchedFraction({ positionSeconds: 30, completed: false })).toBeNull();
    expect(watchedFraction({ positionSeconds: 30, durationSeconds: 120, completed: false })).toBe(0.25);
    expect(watchedFraction({ positionSeconds: 0, completed: true })).toBe(1);
  });

  it("continues the most recently played unfinished video", () => {
    const progress = new Map<number, RecordProgress>([
      [1, { positionSeconds: 40, completed: false, lastPlayedAt: "2026-01-02 10:00:00" }],
      [2, { positionSeconds: 60, completed: false, lastPlayedAt: "2026-01-03 10:00:00" }],
      [3, { positionSeconds: 70, completed: true, lastPlayedAt: "2026-01-04 10:00:00" }],
    ]);
    expect(continueCandidate([1, 2, 3], progress)).toEqual({ id: 2, position: 60 });
    expect(continueCandidate([3], progress)).toBeNull();
  });
});

describe("createProgressLoader", () => {
  it("reads at most a few tiles at once, each only once, and stops when cancelled", async () => {
    const started: number[] = [];
    const pending = new Map<number, () => void>();
    const loaded: number[] = [];
    const loader = createProgressLoader({
      concurrency: 2,
      load: (id) => {
        started.push(id);
        return new Promise<RecordProgress>((resolve) => {
          pending.set(id, () => resolve({ positionSeconds: id, completed: false }));
        });
      },
      onLoaded: (id) => loaded.push(id),
    });
    for (const id of [1, 2, 3, 1, 4]) loader.request(id);
    expect(started).toEqual([1, 2]);

    pending.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual([1]);
    expect(started).toEqual([1, 2, 3]);

    loader.cancel();
    pending.get(2)?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual([1]);
    expect(started).toEqual([1, 2, 3]);
  });
});

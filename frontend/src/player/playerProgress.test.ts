import { describe, expect, it } from "vitest";

import {
  newestMediaProgress,
  REMOTE_PROGRESS_INTERVAL_MS,
  shouldSaveLocalProgress,
  shouldSaveRemoteProgress,
  type ProgressSaveMarker,
} from "./playerProgress";

const previous: ProgressSaveMarker = {
  mediaItemId: 1,
  position: 10,
  completed: false,
  at: 1_000,
};

describe("shouldSaveRemoteProgress", () => {
  it("uses wall-clock time instead of playback distance", () => {
    expect(shouldSaveRemoteProgress(previous, { ...previous, position: 80, at: 20_000 }, false)).toBe(false);
    expect(
      shouldSaveRemoteProgress(previous, { ...previous, position: 80, at: 1_000 + REMOTE_PROGRESS_INTERVAL_MS }, false),
    ).toBe(true);
  });

  it("allows important events while deduplicating the same immediate event", () => {
    expect(shouldSaveRemoteProgress(previous, { ...previous, position: 12, at: 2_000 }, true)).toBe(true);
    expect(shouldSaveRemoteProgress(previous, { ...previous, at: 1_200 }, true)).toBe(false);
    expect(shouldSaveRemoteProgress(previous, { ...previous, completed: true, at: 1_200 }, true)).toBe(true);
  });
});

describe("shouldSaveLocalProgress", () => {
  it("persists once per second and immediately after a seek", () => {
    expect(shouldSaveLocalProgress(previous, { ...previous, position: 11, at: 1_500 }, false)).toBe(false);
    expect(shouldSaveLocalProgress(previous, { ...previous, position: 40, at: 1_500 }, false)).toBe(true);
    expect(shouldSaveLocalProgress(previous, { ...previous, position: 12, at: 2_000 }, false)).toBe(true);
  });
});

describe("newestMediaProgress", () => {
  it("prefers a newer local ISO checkpoint over an older SQLite timestamp", () => {
    const server = { positionSeconds: 20, durationSeconds: 100, completed: false, lastPlayedAt: "2026-07-21 01:00:00" };
    const local = { positionSeconds: 35, durationSeconds: 100, completed: false, lastPlayedAt: "2026-07-21T01:00:10.000Z" };
    expect(newestMediaProgress(server, local)).toEqual(local);
  });

  it("prefers newer server progress from another device", () => {
    const local = { positionSeconds: 35, durationSeconds: 100, completed: false, lastPlayedAt: "2026-07-21T01:00:10.000Z" };
    const server = { positionSeconds: 50, durationSeconds: 100, completed: false, lastPlayedAt: "2026-07-21 01:01:00" };
    expect(newestMediaProgress(local, server)).toEqual(server);
  });
});

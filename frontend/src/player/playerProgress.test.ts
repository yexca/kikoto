import { describe, expect, it } from "vitest";

import {
  NATIVE_MEDIA_POSITION_INTERVAL_MS,
  PLAYER_UI_PROGRESS_INTERVAL_MS,
  REMOTE_PROGRESS_INTERVAL_MS,
  shouldCommitPlayerTime,
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

describe("shouldCommitPlayerTime", () => {
  it("limits routine UI progress commits to two updates per second", () => {
    expect(PLAYER_UI_PROGRESS_INTERVAL_MS).toBe(500);
    expect(shouldCommitPlayerTime(null, 1_000)).toBe(true);
    expect(shouldCommitPlayerTime(1_000, 1_499)).toBe(false);
    expect(shouldCommitPlayerTime(1_000, 1_500)).toBe(true);
  });

  it("commits lifecycle updates immediately and recovers from a reset clock", () => {
    expect(shouldCommitPlayerTime(1_000, 1_100, true)).toBe(true);
    expect(shouldCommitPlayerTime(1_000, 900)).toBe(true);
    expect(NATIVE_MEDIA_POSITION_INTERVAL_MS).toBe(5_000);
  });
});

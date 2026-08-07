import { describe, expect, it } from "vitest";

import { REMOTE_PROGRESS_INTERVAL_MS, shouldSaveRemoteProgress, type ProgressSaveMarker } from "./playerProgress";

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

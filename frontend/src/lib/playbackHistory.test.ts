import { describe, expect, it } from "vitest";

import type { WorkProgressSummary } from "./api";
import { hasPlaybackHistory } from "./playbackHistory";

describe("hasPlaybackHistory", () => {
  it("requires both a persisted media item and a play timestamp", () => {
    expect(hasPlaybackHistory(null)).toBe(false);
    expect(hasPlaybackHistory(undefined)).toBe(false);
    expect(hasPlaybackHistory(progress())).toBe(false);
    expect(hasPlaybackHistory(progress({ mediaItemId: 1 }))).toBe(false);
    expect(hasPlaybackHistory(progress({ lastPlayedAt: "2026-08-10T00:00:00Z" }))).toBe(false);
  });

  it("marks completed and resumable cursors as previously played", () => {
    expect(hasPlaybackHistory(progress({ mediaItemId: 1, lastPlayedAt: "2026-08-10T00:00:00Z" }))).toBe(true);
    const completed = progress({ mediaItemId: 2, lastPlayedAt: "2026-08-10T00:00:00Z", completed: true });
    expect(hasPlaybackHistory(completed)).toBe(true);
  });
});

function progress(overrides: Partial<WorkProgressSummary> = {}): WorkProgressSummary {
  return {
    workId: null,
    mediaWorkId: null,
    mediaItemId: null,
    fileSourceId: null,
    locationId: null,
    locationType: "",
    title: "",
    positionSeconds: 0,
    durationSeconds: null,
    lastPlayedAt: null,
    completed: false,
    ...overrides,
  };
}

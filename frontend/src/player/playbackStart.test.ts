import { describe, expect, it } from "vitest";

import { normalizePlaybackStartPosition, shouldCheckpointPause } from "./playbackStart";

describe("normalizePlaybackStartPosition", () => {
  it("starts ordinary playback at zero", () => {
    expect(normalizePlaybackStartPosition()).toBe(0);
    expect(normalizePlaybackStartPosition(0)).toBe(0);
  });

  it("keeps only an explicit positive finite Resume position", () => {
    expect(normalizePlaybackStartPosition(42.5)).toBe(42.5);
    expect(normalizePlaybackStartPosition(-1)).toBe(0);
    expect(normalizePlaybackStartPosition(Number.NaN)).toBe(0);
    expect(normalizePlaybackStartPosition(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("shouldCheckpointPause", () => {
  it("does not overwrite completion when ended is followed by pause", () => {
    expect(shouldCheckpointPause("queue:track:1", "queue:track:1")).toBe(false);
  });

  it("checkpoints ordinary pauses and a different playback instance", () => {
    expect(shouldCheckpointPause(null, "queue:track:1")).toBe(true);
    expect(shouldCheckpointPause("queue:track:1", "queue:track:2")).toBe(true);
  });
});

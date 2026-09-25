import { describe, expect, it } from "vitest";

import {
  canPersistPlaybackProgress,
  normalizePlaybackStartPosition,
  restoredCursorStartPosition,
  shouldCheckpointPause,
} from "./playbackStart";

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

describe("restoredCursorStartPosition", () => {
  const cursor = { positionSeconds: 42, durationSeconds: 180, completed: false, lastPlayedAt: null };

  it("continues an unfinished cursor", () => {
    expect(restoredCursorStartPosition(cursor)).toBe(42);
  });

  it("starts at zero without a usable unfinished cursor", () => {
    expect(restoredCursorStartPosition(null)).toBe(0);
    expect(restoredCursorStartPosition({ ...cursor, completed: true })).toBe(0);
    expect(restoredCursorStartPosition({ ...cursor, positionSeconds: Number.NaN })).toBe(0);
  });
});

describe("canPersistPlaybackProgress", () => {
  const instance = "queue:track:1";

  it("waits for the start position and listener intent in the same instance", () => {
    expect(canPersistPlaybackProgress(instance, instance, instance)).toBe(true);
    expect(canPersistPlaybackProgress(instance, null, instance)).toBe(false);
    expect(canPersistPlaybackProgress(instance, instance, null)).toBe(false);
  });

  it("does not carry listener intent into a different instance", () => {
    expect(canPersistPlaybackProgress("queue:track:2", "queue:track:2", instance)).toBe(false);
    expect(canPersistPlaybackProgress(null, null, null)).toBe(false);
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

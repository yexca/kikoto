import { describe, expect, it } from "vitest";

import {
  NATIVE_MEDIA_POSITION_INTERVAL_MS,
  PLAYER_UI_PROGRESS_INTERVAL_MS,
  shouldCommitPlayerTime,
} from "./playerProgress";

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

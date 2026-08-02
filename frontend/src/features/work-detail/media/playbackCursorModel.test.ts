import { describe, expect, it } from "vitest";

import type { MediaProgressUpdate, WorkProgressSummary } from "@/lib/api";
import { cursorUpdateAffectsWork } from "./playbackCursorModel";

const cursor = {
  workId: 10,
  mediaWorkId: 11,
  mediaItemId: 12,
  fileSourceId: 2,
  locationId: 3,
  locationType: "remote_stream",
  title: "Track",
  positionSeconds: 20,
  durationSeconds: 100,
  lastPlayedAt: "2026-08-02 10:00:00",
  completed: false,
} satisfies WorkProgressSummary;

const update = {
  workId: 10,
  mediaWorkId: 11,
  mediaItemId: 12,
  fileSourceId: 2,
  locationId: 3,
  locationType: "remote_stream",
  positionSeconds: 100,
  durationSeconds: 100,
  lastPlayedAt: "2026-08-02 10:10:00",
  completed: true,
} satisfies MediaProgressUpdate;

describe("cursorUpdateAffectsWork", () => {
  it("matches both the canonical owner and media edition", () => {
    expect(cursorUpdateAffectsWork(10, cursor, update)).toBe(true);
    expect(cursorUpdateAffectsWork(11, null, update)).toBe(true);
  });

  it("uses the loaded canonical cursor when the requested edition is a sibling", () => {
    expect(cursorUpdateAffectsWork(13, cursor, update)).toBe(true);
    expect(cursorUpdateAffectsWork(13, null, update)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import type { RecordProgress } from "@/lib/api";

import { RECORD_TRACK_SAVE_INTERVAL_MS, RecordTrackProgressSaver } from "./recordTrackProgress";

function harness() {
  let now = 0;
  const writes: [number, RecordProgress][] = [];
  const saver = new RecordTrackProgressSaver(
    (assetId, progress) => writes.push([assetId, progress]),
    () => now,
  );
  return { saver, writes, advance: (ms: number) => (now += ms) };
}

describe("Record track progress", () => {
  it("saves a playing file at most once per interval and at once on a forced save", () => {
    const { saver, writes, advance } = harness();
    saver.save(21, 3, 60, false, false);
    advance(2_000);
    saver.save(21, 5, 60, false, false);
    expect(writes).toHaveLength(1);
    advance(RECORD_TRACK_SAVE_INTERVAL_MS);
    saver.save(21, 15, 60, false, false);
    saver.save(21, 16.5, 60, false, true);
    expect(writes.map(([, progress]) => progress.positionSeconds)).toEqual([3, 15, 16.5]);
  });

  it("skips an unmoved position but always saves the end and another file", () => {
    const { saver, writes } = harness();
    saver.save(21, 30, 60, false, true);
    saver.save(21, 30.4, 60, false, true);
    saver.save(21, 60, 60, true, true);
    saver.save(22, 0.5, null, false, true);
    expect(writes).toEqual([
      [21, { positionSeconds: 30, durationSeconds: 60, completed: false, order: 1 }],
      [21, { positionSeconds: 60, durationSeconds: 60, completed: true, order: 2 }],
      [22, { positionSeconds: 0.5, durationSeconds: undefined, completed: false, order: 3 }],
    ]);
  });

  it("orders each save after the one before by the client clock", () => {
    const { saver, writes, advance } = harness();
    advance(5_000);
    saver.save(21, 3, 60, false, true);
    saver.save(21, 8, 60, false, true);
    advance(20_000);
    saver.save(21, 30, 60, false, true);
    expect(writes.map(([, progress]) => progress.order)).toEqual([5_000, 5_001, 25_000]);
  });
});

import { describe, expect, it } from "vitest";

import {
  readVideoResumePosition,
  resumableVideoPosition,
  writeVideoResumePosition,
} from "@/features/work-detail/media/videoResume";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const key = "kikoto:video-resume:v1:test";

describe("video resume positions", () => {
  it("remembers where each location stopped", () => {
    const storage = memoryStorage();
    writeVideoResumePosition(storage, key, 1, 42.04, 180);
    writeVideoResumePosition(storage, key, 2, 90, 600);
    expect(readVideoResumePosition(storage, key, 1)).toBe(42);
    expect(readVideoResumePosition(storage, key, 2)).toBe(90);
    expect(readVideoResumePosition(storage, key, 3)).toBeNull();
    expect(readVideoResumePosition(storage, "kikoto:video-resume:v1:other", 1)).toBeNull();
  });

  it("forgets a location that restarted or reached its end", () => {
    const storage = memoryStorage();
    writeVideoResumePosition(storage, key, 1, 42, 180);
    writeVideoResumePosition(storage, key, 1, 3, 180);
    expect(readVideoResumePosition(storage, key, 1)).toBeNull();

    writeVideoResumePosition(storage, key, 1, 42, 180);
    writeVideoResumePosition(storage, key, 1, 170, 180);
    expect(readVideoResumePosition(storage, key, 1)).toBeNull();
    expect(storage.values.has(key)).toBe(false);
  });

  it("treats the last five percent of a long video as finished", () => {
    expect(resumableVideoPosition(3400, 3600)).toBe(3400);
    expect(resumableVideoPosition(3500, 3600)).toBeNull();
    expect(resumableVideoPosition(160, 180)).toBe(160);
    expect(resumableVideoPosition(170, 180)).toBeNull();
    expect(resumableVideoPosition(42, Number.NaN)).toBe(42);
  });

  it("keeps the most recently watched locations within a bounded store", () => {
    const storage = memoryStorage();
    for (let location = 1; location <= 205; location++) {
      writeVideoResumePosition(storage, key, location, 60, 600, location);
    }
    expect(readVideoResumePosition(storage, key, 5)).toBeNull();
    expect(readVideoResumePosition(storage, key, 6)).toBe(60);
    expect(readVideoResumePosition(storage, key, 205)).toBe(60);
  });

  it("stores nothing for a remote preview without a location", () => {
    const storage = memoryStorage();
    writeVideoResumePosition(storage, key, -1, 60, 600);
    expect(storage.values.size).toBe(0);
    expect(readVideoResumePosition(storage, key, -1)).toBeNull();
  });

  it("ignores malformed stored data", () => {
    const storage = memoryStorage();
    storage.setItem(key, JSON.stringify({ 1: { position: "42" }, x: { position: 1, updatedAt: 1 } }));
    expect(readVideoResumePosition(storage, key, 1)).toBeNull();
    storage.setItem(key, "{");
    expect(readVideoResumePosition(storage, key, 1)).toBeNull();
    writeVideoResumePosition(storage, key, 1, 42, 180);
    expect(readVideoResumePosition(storage, key, 1)).toBe(42);
  });
});

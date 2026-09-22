import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentClientStorageScope = vi.hoisted(() =>
  vi.fn((principalID: number | null) => `scope:${principalID ?? "anonymous"}`),
);

vi.mock("@/lib/clientStorageScope", () => ({ currentClientStorageScope }));

import type { MediaItem } from "@/lib/api";
import { getCachedWorkMedia, invalidateCachedWorkMedia, setCachedWorkMedia } from "./workMediaCache";

function mediaItems(count = 1) {
  return Array.from({ length: count }, () => ({}) as MediaItem);
}

describe("work media cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentClientStorageScope.mockImplementation((principalID: number | null) => `scope:${principalID ?? "anonymous"}`);
  });

  afterEach(() => vi.useRealTimers());

  it("keeps media isolated by the active storage scope and supports explicit invalidation", () => {
    const media = mediaItems();
    setCachedWorkMedia(1, 101, media);

    expect(getCachedWorkMedia(1, 101)).toBe(media);
    expect(getCachedWorkMedia(1, 102)).toBeNull();

    invalidateCachedWorkMedia(1, 101);
    expect(getCachedWorkMedia(1, 101)).toBeNull();
  });

  it("expires idle entries before returning them", () => {
    setCachedWorkMedia(2, 102, mediaItems());
    vi.advanceTimersByTime(30 * 60_000 + 1);

    expect(getCachedWorkMedia(2, 102)).toBeNull();
  });

  it("does not retain an empty media result", () => {
    setCachedWorkMedia(3, 102, []);

    expect(getCachedWorkMedia(3, 102)).toBeNull();
  });

  it("retains recently used entries while bounding the number of cached works", () => {
    for (let workID = 0; workID < 20; workID++) {
      setCachedWorkMedia(workID, 103, mediaItems());
    }
    expect(getCachedWorkMedia(0, 103)).not.toBeNull();

    setCachedWorkMedia(20, 103, mediaItems());

    expect(getCachedWorkMedia(0, 103)).not.toBeNull();
    expect(getCachedWorkMedia(1, 103)).toBeNull();
    expect(getCachedWorkMedia(20, 103)).not.toBeNull();
  });

  it("drops an entry that alone exceeds the media item budget", () => {
    setCachedWorkMedia(99, 104, mediaItems(20_001));

    expect(getCachedWorkMedia(99, 104)).toBeNull();
  });
});

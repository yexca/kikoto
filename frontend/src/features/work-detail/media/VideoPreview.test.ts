import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSERVATIVE_HLS_CONFIG,
  prepareVideoPlayback,
  videoPlaybackFailureKey,
} from "@/features/work-detail/media/videoPlaybackModel";

afterEach(() => vi.useRealTimers());

describe("conservative HLS playback", () => {
  it("keeps foreground and memory work bounded for older devices", () => {
    expect(CONSERVATIVE_HLS_CONFIG.enableWorker).toBe(true);
    expect(CONSERVATIVE_HLS_CONFIG.lowLatencyMode).toBe(false);
    expect(CONSERVATIVE_HLS_CONFIG.maxBufferLength).toBeLessThanOrEqual(12);
    expect(CONSERVATIVE_HLS_CONFIG.maxMaxBufferLength).toBeLessThanOrEqual(24);
    expect(CONSERVATIVE_HLS_CONFIG.maxBufferSize).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(CONSERVATIVE_HLS_CONFIG.fragLoadingTimeOut).toBeGreaterThanOrEqual(120_000);
  });

  it("cancels a pending preparation retry when the video closes", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const load = vi.fn().mockRejectedValue(Object.assign(new Error("Busy"), { status: 503, retryable: true }));
    const result = prepareVideoPlayback(load, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops after two automatic preparation retries", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("Busy"), { status: 503, retryable: true });
    const load = vi.fn().mockRejectedValue(busy);
    const result = prepareVideoPlayback(load, new AbortController().signal);
    const rejected = expect(result).rejects.toBe(busy);
    await vi.runAllTimersAsync();
    await rejected;
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps upstream diagnostics out of the video recovery surface", () => {
    expect(videoPlaybackFailureKey(Object.assign(new Error("Untrusted upstream failure"), { status: 500 }))).toBe(
      "videoPlayback.prepareFailed",
    );
  });
});

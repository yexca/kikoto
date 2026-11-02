import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSERVATIVE_HLS_CONFIG,
  prepareVideoPlayback,
  retriesRemuxAsTranscode,
  videoPlaybackFailureKey,
} from "@/features/work-detail/media/videoPlaybackModel";
import { prefersNativeVideoHls } from "@/player/mediaPlayback";

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

  it("prepares a remux the browser cannot decode again as a transcode", () => {
    expect(retriesRemuxAsTranscode({ delivery: "hls", conversion: "remux" })).toBe(true);
    expect(retriesRemuxAsTranscode({ delivery: "hls", conversion: "transcode" })).toBe(false);
    expect(retriesRemuxAsTranscode({ delivery: "hls" })).toBe(false);
    expect(retriesRemuxAsTranscode({ delivery: "direct", conversion: "none" })).toBe(false);
  });

  it("keeps upstream diagnostics out of the video recovery surface", () => {
    expect(videoPlaybackFailureKey(Object.assign(new Error("Untrusted upstream failure"), { status: 500 }))).toBe(
      "videoPlayback.prepareFailed",
    );
  });
});

describe("video HLS player choice", () => {
  afterEach(() => vi.unstubAllGlobals());
  const nativeHls = { canPlayType: (type: string) => (type === "application/vnd.apple.mpegurl" ? "maybe" : "") };

  it("plays HLS natively on iOS and iPadOS", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    expect(prefersNativeVideoHls(nativeHls)).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 });
    expect(prefersNativeVideoHls(nativeHls)).toBe(true);
  });

  it("keeps hls.js on Android, desktop Safari, and without native HLS", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 15; wv)", maxTouchPoints: 5 });
    expect(prefersNativeVideoHls(nativeHls)).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 });
    expect(prefersNativeVideoHls(nativeHls)).toBe(false);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone)" });
    expect(prefersNativeVideoHls({ canPlayType: () => "" })).toBe(false);
  });
});

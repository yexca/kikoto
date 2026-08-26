import { describe, expect, it } from "vitest";

import { CONSERVATIVE_HLS_CONFIG } from "@/features/work-detail/media/videoPlaybackModel";

describe("conservative HLS playback", () => {
  it("keeps foreground and memory work bounded for older devices", () => {
    expect(CONSERVATIVE_HLS_CONFIG.enableWorker).toBe(true);
    expect(CONSERVATIVE_HLS_CONFIG.lowLatencyMode).toBe(false);
    expect(CONSERVATIVE_HLS_CONFIG.maxBufferLength).toBeLessThanOrEqual(12);
    expect(CONSERVATIVE_HLS_CONFIG.maxMaxBufferLength).toBeLessThanOrEqual(24);
    expect(CONSERVATIVE_HLS_CONFIG.maxBufferSize).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(CONSERVATIVE_HLS_CONFIG.fragLoadingTimeOut).toBeGreaterThanOrEqual(120_000);
  });
});

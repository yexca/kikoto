import { afterEach, describe, expect, it, vi } from "vitest";

import { audioHlsPlayback } from "./mediaPlayback";

function stubBrowser({ nativeHls = false, mse = false, userAgent = "Mozilla/5.0 (Windows NT 10.0)" }) {
  vi.stubGlobal("document", {
    createElement: () => ({
      canPlayType: (mime: string) => (nativeHls && mime === "application/vnd.apple.mpegurl" ? "maybe" : ""),
    }),
  });
  vi.stubGlobal("navigator", { userAgent, platform: "Win32", maxTouchPoints: 0 });
  vi.stubGlobal("MediaSource", mse ? { isTypeSupported: (type: string) => type.includes("mp4a.40.2") } : undefined);
}

describe("audio HLS playback support", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the native player on iOS, where it keeps playing on the lock screen", () => {
    stubBrowser({ nativeHls: true, mse: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    expect(audioHlsPlayback()).toBe("native");
  });

  it("prefers Media Source Extensions elsewhere and falls back to native HLS", () => {
    stubBrowser({ nativeHls: true, mse: true });
    expect(audioHlsPlayback()).toBe("mse");
    stubBrowser({ nativeHls: true });
    expect(audioHlsPlayback()).toBe("native");
    stubBrowser({});
    expect(audioHlsPlayback()).toBeNull();
  });
});

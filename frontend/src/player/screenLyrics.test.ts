import { describe, expect, it } from "vitest";

import { selectScreenLyricsBackend } from "@/player/screenLyrics";

const none = { nativeOverlay: false, documentPictureInPicture: false, videoPictureInPicture: false };

describe("selectScreenLyricsBackend", () => {
  it("prefers a native surface, which keeps advancing in the background", () => {
    expect(
      selectScreenLyricsBackend({ nativeOverlay: true, documentPictureInPicture: true, videoPictureInPicture: true }),
    ).toBe("native");
  });

  it("opens screen lyrics in the iOS shell, whose web view has no web Picture-in-Picture", () => {
    expect(selectScreenLyricsBackend({ ...none, nativeOverlay: true })).toBe("native");
  });

  it("falls back to Document, then video Picture-in-Picture in browsers", () => {
    expect(selectScreenLyricsBackend({ ...none, documentPictureInPicture: true, videoPictureInPicture: true })).toBe(
      "document-pip",
    );
    expect(selectScreenLyricsBackend({ ...none, videoPictureInPicture: true })).toBe("video-pip");
  });

  it("hides screen lyrics when no surface is available", () => {
    expect(selectScreenLyricsBackend(none)).toBeNull();
  });
});

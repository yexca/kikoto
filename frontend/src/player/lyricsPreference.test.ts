import { describe, expect, it } from "vitest";

import { lyricsPreferencePersists } from "./lyricsPreference";

describe("lyricsPreferencePersists", () => {
  it("stores the choice for a library audio track", () => {
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", lyricsPreferencePersistable: true })).toBe(true);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", progressRecordable: true })).toBe(true);
  });

  it("keeps the choice in the session for a video track, which the server does not store one for", () => {
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "video", lyricsPreferencePersistable: true })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "video", progressRecordable: true })).toBe(false);
  });

  it("keeps the choice in the session for previews and unsaved tracks", () => {
    expect(lyricsPreferencePersists({ mediaItemId: -1, kind: "audio", progressRecordable: true })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio", lyricsPreferencePersistable: false })).toBe(false);
    expect(lyricsPreferencePersists({ mediaItemId: 5, kind: "audio" })).toBe(false);
  });
});

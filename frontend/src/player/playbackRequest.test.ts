import { describe, expect, it } from "vitest";

import { isActivePlaybackRequest } from "./playbackRequest";

describe("isActivePlaybackRequest", () => {
  it("keeps the current play request authoritative", () => {
    expect(isActivePlaybackRequest({ generation: 4, playbackKey: "track:2" }, 4, "track:2", true)).toBe(true);
  });

  it("rejects results from an older request or source", () => {
    expect(isActivePlaybackRequest({ generation: 3, playbackKey: "track:2" }, 4, "track:2", true)).toBe(false);
    expect(isActivePlaybackRequest({ generation: 4, playbackKey: "track:1" }, 4, "track:2", true)).toBe(false);
  });

  it("rejects a pending result after playback was paused", () => {
    expect(isActivePlaybackRequest({ generation: 4, playbackKey: "track:2" }, 4, "track:2", false)).toBe(false);
  });
});

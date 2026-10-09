import { describe, expect, it } from "vitest";

import type { PlayerTrack } from "./playerTypes";
import { systemMediaDetails } from "./systemMediaPrivacy";

const track = {
  title: "Track 01",
  workCode: "RJ00000001",
  workTitle: "Synthetic Work",
  circle: "Synthetic Circle",
  coverUrl: "/api/assets/covers/RJ00000001",
} as PlayerTrack;

describe("system media details", () => {
  it("shows the track, circle, work, and cover for everything", () => {
    expect(systemMediaDetails(track, "full")).toEqual({
      title: "Track 01",
      artist: "Synthetic Circle",
      album: "Synthetic Work",
      coverUrl: "/api/assets/covers/RJ00000001",
    });
  });

  it("keeps the text but drops the cover when the cover is hidden", () => {
    expect(systemMediaDetails(track, "hideCover")).toEqual({
      title: "Track 01",
      artist: "Synthetic Circle",
      album: "Synthetic Work",
      coverUrl: "",
    });
  });

  it("shows only the app name when details are hidden", () => {
    expect(systemMediaDetails(track, "hidden")).toEqual({ title: "Kikoto", artist: "", album: "", coverUrl: "" });
  });
});

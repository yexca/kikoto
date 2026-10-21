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
    expect(systemMediaDetails({ ...track, displayTitle: "第一首.mp3" }, "hidden").title).toBe("Kikoto");
  });

  it("names a track by its display name unless the listener asked for real names", () => {
    const named = { ...track, displayTitle: "第一首.mp3" };
    expect(systemMediaDetails(named, "full").title).toBe("第一首.mp3");
    expect(systemMediaDetails(named, "full", true).title).toBe("Track 01");
  });
});

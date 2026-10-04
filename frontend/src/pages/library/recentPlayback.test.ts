import { describe, expect, it } from "vitest";

import { formatPlaybackTime, progressPercent, recentTrackName } from "./recentPlayback";

const progress = {
  workId: 1,
  mediaWorkId: 1,
  mediaItemId: 1,
  fileSourceId: null,
  locationId: null,
  locationType: "",
  title: "",
  positionSeconds: 0,
  durationSeconds: null,
  lastPlayedAt: null,
  completed: false,
};

describe("recent playback presentation", () => {
  it("names the saved track by its last path segment", () => {
    expect(recentTrackName({ ...progress, title: "Disc 1/MP3/07 Ending" })).toBe("07 Ending");
    expect(recentTrackName({ ...progress, title: "Track one" })).toBe("Track one");
    expect(recentTrackName({ ...progress, title: "" })).toBe("");
  });

  it("formats long positions with hours and fills finished works", () => {
    expect(formatPlaybackTime(3725)).toBe("1:02:05");
    expect(formatPlaybackTime(42)).toBe("0:42");
    expect(progressPercent({ ...progress, positionSeconds: 30, durationSeconds: 120 })).toBe(25);
    expect(progressPercent({ ...progress, completed: true })).toBe(100);
  });
});

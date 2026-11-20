import { describe, expect, it } from "vitest";

import type { PlayerTrack } from "./playerTypes";
import { queueDisplayTitleKey, withQueueDisplayTitles } from "./queueDisplayNames";

function track(mediaItemId: number, locationId: number, displayTitle?: string): PlayerTrack {
  return {
    queueItemId: `queue-${mediaItemId}`,
    mediaItemId,
    locationId,
    title: `${mediaItemId}.mp3`,
    ...(displayTitle ? { displayTitle } : {}),
    kind: "audio",
    folderPath: "",
    locationType: "local",
    streamUrl: `/api/media/${locationId}/stream`,
    sizeBytes: null,
    availability: "available",
    workId: 1,
    workCode: "RJ00000000",
    workTitle: "Example Work",
    coverUrl: "",
    circle: "",
    progress: null,
    progressRecordable: true,
    lyricsLocationId: null,
    lyricsTitle: "",
  };
}

describe("queue display names", () => {
  it("renames queued tracks without touching anything else and keeps unresolved names", () => {
    const tracks = [track(1, 101), track(2, 102, "Kept name")];
    const renamed = withQueueDisplayTitles(tracks, new Map([[queueDisplayTitleKey(tracks[0]), "Opening"]]));

    expect(renamed[0]).toEqual({ ...tracks[0], displayTitle: "Opening" });
    expect(renamed[1]).toBe(tracks[1]);
  });

  it("drops a name the listener's languages no longer give, and keeps the queue when nothing changes", () => {
    const tracks = [track(1, 101, "Opening")];
    const key = queueDisplayTitleKey(tracks[0]);

    expect(withQueueDisplayTitles(tracks, new Map([[key, undefined]]))[0].displayTitle).toBeUndefined();
    expect(withQueueDisplayTitles(tracks, new Map([[key, "Opening"]]))).toBe(tracks);
  });
});

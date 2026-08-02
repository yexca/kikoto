import { describe, expect, it } from "vitest";

import type { MediaItem, SourceAvailabilitySource, WorkDetail } from "@/lib/api";
import { buildSourceTabs, buildTrackedPresenceOptions, currentRemoteSourceWorkCode } from "./sourceContextModel";

describe("sourceContextModel", () => {
  it("aggregates tracked presences into one tab and reflects the selected presence", () => {
    const presences = [
      { type: "tracked", availability: "available", fileSourceId: 7, fileSourceCode: "remote_a", fileSourceName: "Remote A", remoteId: "a" },
      { type: "tracked", availability: "available", fileSourceId: 8, fileSourceCode: "remote_b", fileSourceName: "Remote B", remoteId: "b" },
    ] as NonNullable<WorkDetail["sourcePresence"]>;
    const mediaItems = [{
      id: 1,
      title: "track.mp3",
      kind: "audio",
      fingerprint: "tracked-context",
      durationSeconds: 10,
      progress: null,
      locations: [{
        id: 2,
        fileSourceId: 7,
        fileSourceCode: "remote_a",
        fileSourceName: "Remote A",
        locationType: "remote_stream",
        path: "track.mp3",
        streamUrl: "/remote/track.mp3",
        downloadUrl: "/remote/track.mp3",
        availability: "available",
        sizeBytes: 12,
        durationSeconds: 10,
      }],
    }] as MediaItem[];

    const options = buildTrackedPresenceOptions(mediaItems, [], presences);
    expect(options.map((option) => ({ label: option.label, forked: option.forked }))).toEqual([
      { label: "Remote A", forked: true },
      { label: "Remote B", forked: false },
    ]);

    const tabs = buildSourceTabs(mediaItems, [], presences, options[1]);
    const trackedTabs = tabs.filter((tab) => tab.kind === "tracked");
    expect(trackedTabs).toHaveLength(1);
    expect(trackedTabs[0]).toMatchObject({
      key: "tracked",
      label: "Tracked",
      sourceName: "Remote B",
      presence: presences[1],
      status: "red",
      statusLabel: "Tracked directory unavailable",
    });
  });

  it("uses the currently loaded remote edition instead of the routed edition", () => {
    const summary = {
      primaryCode: "SAMPLE-ORIGIN",
      remoteId: "origin-id",
    } as SourceAvailabilitySource;

    expect(currentRemoteSourceWorkCode({
      remoteCode: "SAMPLE-EDITION-B",
      primaryCode: "SAMPLE-ORIGIN",
      remoteId: "edition-b-id",
    }, "SAMPLE-EDITION-A", summary, "SAMPLE-ORIGIN")).toBe("SAMPLE-EDITION-B");
  });

  it("uses the family-level forked summary when the active edition has no matching media", () => {
    const presences = [{
      type: "tracked",
      availability: "available",
      fileSourceId: 7,
      fileSourceName: "Remote A",
      forked: true,
    }] as NonNullable<WorkDetail["sourcePresence"]>;

    expect(buildTrackedPresenceOptions([], [], presences)[0]).toMatchObject({
      forked: true,
      status: "green",
      statusLabel: "Forked directory available",
    });
  });
});

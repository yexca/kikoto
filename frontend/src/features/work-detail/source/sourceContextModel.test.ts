import { describe, expect, it } from "vitest";

import type { MediaItem, SourceAvailabilitySource, WorkDetail } from "@/lib/api";
import {
  buildSourceTabs,
  buildTrackedPresenceOptions,
  currentRemoteSourceWorkCode,
  trackedPresenceKey,
} from "./sourceContextModel";

describe("sourceContextModel", () => {
  it("aggregates tracked presences into one tab and reflects the selected presence", () => {
    const presences = [
      {
        type: "tracked",
        availability: "available",
        fileSourceId: 7,
        fileSourceCode: "remote_a",
        fileSourceName: "Remote A",
        remoteId: "a",
      },
      {
        type: "tracked",
        availability: "available",
        fileSourceId: 8,
        fileSourceCode: "remote_b",
        fileSourceName: "Remote B",
        remoteId: "b",
      },
    ] as NonNullable<WorkDetail["sourcePresence"]>;
    const mediaItems = [
      {
        id: 1,
        title: "track.mp3",
        kind: "audio",
        fingerprint: "tracked-context",
        durationSeconds: 10,
        progress: null,
        locations: [
          {
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
          },
        ],
      },
    ] as MediaItem[];

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
      status: "unavailable",
      statusLabel: "Tracked directory unavailable",
    });
  });

  it("hides the Tracked placeholder by default until a tracked presence exists", () => {
    const tabs = buildSourceTabs([localMediaItem(1, 3, "Main local library")]);
    expect(
      tabs.map((tab) => ({ key: tab.key, label: tab.label, sourceName: tab.sourceName, autoVisible: tab.autoVisible })),
    ).toEqual([
      { key: "3:local", label: "Local", sourceName: "Main local library", autoVisible: undefined },
      { key: "tracked", label: "Tracked", sourceName: "Tracked", autoVisible: false },
    ]);
  });

  it("hides disabled remote sources by default", () => {
    const remote = (id: number, enabled: boolean, status: SourceAvailabilitySource["status"]) => ({
      source: { id, code: `remote_${id}`, displayName: `Remote ${id}`, sourceType: "kikoeru_compatible", enabled },
      summary: { sourceId: id, status } as SourceAvailabilitySource,
    });
    const tabs = buildSourceTabs(
      [localMediaItem(1, 3, "Main local library")],
      [remote(7, true, "not_found"), remote(8, false, "unknown"), remote(9, true, "disabled")],
    );
    expect(
      tabs
        .filter((tab) => tab.kind === "remote")
        .map((tab) => ({ key: tab.visibilityKey, autoVisible: tab.autoVisible, statusLabel: tab.statusLabel })),
    ).toEqual([
      { key: "remote:7", autoVisible: true, statusLabel: "Not found" },
      { key: "remote:8", autoVisible: false, statusLabel: "Disabled" },
      { key: "remote:9", autoVisible: false, statusLabel: "Disabled" },
    ]);
  });

  it("names local tabs by file source when several local sources hold the work", () => {
    const tabs = buildSourceTabs([localMediaItem(1, 3, "Pool A"), localMediaItem(2, 4, "Pool B")]);
    expect(tabs.filter((tab) => tab.kind === "local").map((tab) => tab.label)).toEqual(["Pool A", "Pool B"]);
  });

  it("uses the currently loaded remote edition instead of the routed edition", () => {
    const summary = {
      primaryCode: "SAMPLE-ORIGIN",
      remoteId: "origin-id",
    } as SourceAvailabilitySource;

    expect(
      currentRemoteSourceWorkCode(
        {
          remoteCode: "SAMPLE-EDITION-B",
          primaryCode: "SAMPLE-ORIGIN",
          remoteId: "edition-b-id",
        },
        "SAMPLE-EDITION-A",
        summary,
        "SAMPLE-ORIGIN",
      ),
    ).toBe("SAMPLE-EDITION-B");
  });

  it("uses the family-level forked summary when the active edition has no matching media", () => {
    const presences = [
      {
        type: "tracked",
        availability: "available",
        fileSourceId: 7,
        fileSourceName: "Remote A",
        forked: true,
      },
    ] as NonNullable<WorkDetail["sourcePresence"]>;

    expect(buildTrackedPresenceOptions([], [], presences)[0]).toMatchObject({
      forked: true,
      status: "available",
      statusLabel: "Forked directory available",
    });
  });

  it("keeps tracked presences from different family editions distinct", () => {
    const base = {
      type: "tracked",
      availability: "available",
      fileSourceId: 7,
      remoteId: "remote-work",
    } as NonNullable<WorkDetail["sourcePresence"]>[number];

    expect(trackedPresenceKey({ ...base, workId: 11 })).not.toBe(trackedPresenceKey({ ...base, workId: 12 }));
  });
});

function localMediaItem(id: number, fileSourceId: number, fileSourceName: string) {
  return {
    id,
    title: `track-${id}.mp3`,
    kind: "audio",
    fingerprint: `local-${id}`,
    durationSeconds: 10,
    progress: null,
    locations: [
      {
        id,
        fileSourceId,
        fileSourceCode: `local_${fileSourceId}`,
        fileSourceName,
        locationType: "local",
        path: `track-${id}.mp3`,
        streamUrl: `/api/media/${id}/stream`,
        downloadUrl: `/api/media/${id}/download`,
        availability: "available",
        sizeBytes: 12,
        durationSeconds: 10,
      },
    ],
  } as MediaItem;
}

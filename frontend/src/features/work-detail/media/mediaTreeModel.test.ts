import { describe, expect, it } from "vitest";

import type { MediaItem, RemoteTrack } from "@/lib/api";
import {
  buildRemoteTree,
  buildTree,
  flattenTracks,
  remoteSelectablePaths,
  treeStats,
} from "./mediaTreeModel";

describe("mediaTreeModel", () => {
  it("builds a local tree for one selected source and keeps alternate playback locations", () => {
    const item = {
      id: 11,
      title: "01.mp3",
      kind: "audio",
      fingerprint: "fingerprint",
      durationSeconds: 90,
      progress: null,
      locations: [
        {
          id: 21,
          fileSourceId: 1,
          fileSourceName: "Local",
          locationType: "local",
          path: "library/RJ09999995/audio/01.mp3",
          streamUrl: "/api/media/21/stream",
          downloadUrl: "",
          availability: "available",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
        {
          id: 22,
          fileSourceId: 1,
          fileSourceName: "Cache",
          locationType: "cache",
          path: "media/01.mp3",
          streamUrl: "/api/media/22/stream",
          downloadUrl: "",
          availability: "available",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
      ],
    } as MediaItem;

    const tree = buildTree([item], 1, "RJ09999995");
    const tracks = flattenTracks(tree);

    expect(tracks).toHaveLength(1);
    expect(tracks[0].sourcePath).toBe("audio/01.mp3");
    expect(tracks[0].locations.map((location) => location.locationId)).toEqual([21, 22]);
    expect(treeStats(tree)).toMatchObject({ files: 1, audio: 1, sizeBytes: 1024, durationSeconds: 90 });
  });

  it("builds remote preview paths without turning folders into playable tracks", () => {
    const remoteTracks = [{
      type: "folder",
      title: "Disc 1",
      children: [{
        type: "audio",
        title: "01.mp3",
        streamUrl: "/remote/01",
        downloadUrl: "/remote/01/download",
        sizeBytes: 2048,
        durationSeconds: 120,
        cacheAvailable: false,
        cacheLocationId: null,
        cachePath: "",
        localAvailable: false,
        localLocationId: null,
        localPath: "",
      }],
    }] as RemoteTrack[];

    const tree = buildRemoteTree(remoteTracks);

    expect(flattenTracks(tree)).toHaveLength(1);
    expect(remoteSelectablePaths(tree)).toEqual(["Disc 1/01.mp3"]);
  });
});

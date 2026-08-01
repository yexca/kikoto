import { describe, expect, it } from "vitest";

import type { MediaItem, RemoteTrack } from "@/lib/api";
import {
  buildRemoteTree,
  buildTree,
  flattenTracks,
  formatDuration,
  formatTrackDuration,
  remoteSelectablePaths,
  toPreferredPlayerTrack,
  toRemotePreviewPlayerTrack,
  treeStats,
} from "./mediaTreeModel";

describe("mediaTreeModel", () => {
  it("formats aggregate durations without showing zero minutes", () => {
    expect(formatDuration(10)).toBe("<1m");
    expect(formatDuration(3720)).toBe("1h 02m");
  });

  it("formats per-track durations with second precision", () => {
    expect(formatTrackDuration(10)).toBe("0:10");
    expect(formatTrackDuration(754)).toBe("12:34");
    expect(formatTrackDuration(3754)).toBe("1:02:34");
    expect(formatTrackDuration(null)).toBe("");
  });

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

  it("selects the best available location for work-level playback", () => {
    const item = {
      id: 11,
      title: "01.mp3",
      kind: "audio",
      fingerprint: "fingerprint",
      durationSeconds: 90,
      progress: null,
      locations: [
        {
          id: 31,
          fileSourceId: 2,
          fileSourceName: "Remote",
          locationType: "remote_stream",
          path: "remote/01.mp3",
          streamUrl: "/remote/01",
          downloadUrl: "",
          availability: "remote",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
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
      ],
    } as MediaItem;
    const work = {
      id: 7,
      primaryCode: "RJ09999995",
      title: "Work",
      coverUrl: "",
      circle: "Circle",
      mediaItems: [item],
    } as Parameters<typeof toPreferredPlayerTrack>[1];
    const track = flattenTracks(buildTree([item], null, work.primaryCode))[0];

    expect(toPreferredPlayerTrack(track, work)).toMatchObject({
      locationId: 21,
      locationType: "local",
      streamUrl: "/api/media/21/stream",
    });
  });

  it("hides items whose selected source only has missing locations", () => {
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
          fileSourceName: "Missing local",
          locationType: "local",
          path: "library/RJ09999995/audio/01.mp3",
          streamUrl: "",
          downloadUrl: "",
          availability: "missing",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
        {
          id: 31,
          fileSourceId: 2,
          fileSourceName: "Available local",
          locationType: "local",
          path: "backup/RJ09999995/audio/01.mp3",
          streamUrl: "/api/media/31/stream",
          downloadUrl: "",
          availability: "available",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
      ],
    } as MediaItem;

    expect(treeStats(buildTree([item], 1, "RJ09999995")).files).toBe(0);
    expect(flattenTracks(buildTree([item], null, "RJ09999995"))[0]).toMatchObject({ locationId: 31 });
  });

  it("keeps available non-playable files in the directory tree", () => {
    const item = {
      id: 12,
      title: "cover.jpg",
      kind: "image",
      fingerprint: "cover-fingerprint",
      durationSeconds: null,
      progress: null,
      locations: [{
        id: 24,
        fileSourceId: 1,
        fileSourceName: "Local",
        locationType: "local",
        path: "library/RJ09999995/cover.jpg",
        streamUrl: "",
        downloadUrl: "/api/media/24/download",
        availability: "available",
        sizeBytes: 2048,
        durationSeconds: null,
      }],
    } as MediaItem;

    const tree = buildTree([item], 1, "RJ09999995");

    expect(treeStats(tree)).toMatchObject({ files: 1, playable: 0, sizeBytes: 2048 });
    expect(tree.files[0]).toMatchObject({ kind: "image", locationId: 24, title: "cover.jpg" });
    expect(flattenTracks(tree)).toHaveLength(0);
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

  it("uses source, work, and path for remote playback identity", () => {
    const remoteTracks = [{
      type: "audio",
      title: "01.mp3",
      streamUrl: "/remote/01",
      downloadUrl: "/remote/01/download",
      cacheAvailable: false,
      cacheLocationId: null,
      cachePath: "",
      localAvailable: false,
      localLocationId: null,
      localPath: "",
    }] as RemoteTrack[];

    const first = flattenTracks(buildRemoteTree(remoteTracks, { sourceId: 7, workCode: "TEST-WORK-001" }))[0];
    const second = flattenTracks(buildRemoteTree(remoteTracks, { sourceId: 8, workCode: "TEST-WORK-002" }))[0];

    expect(first.playbackKey).toBeTruthy();
    expect(second.playbackKey).toBeTruthy();
    expect(first.playbackKey).not.toBe(second.playbackKey);
    expect(toRemotePreviewPlayerTrack(first, {
      sourceId: 7,
      sourceCode: "remote_a",
      sourceName: "Remote A",
      remoteId: "remote-1",
      primaryCode: "TEST-WORK-001",
      remoteCode: "TEST-WORK-001",
      title: "Work",
      coverUrl: "",
      sourceUrl: "",
      publicWorkUrl: "",
      circle: "",
      rating: null,
      sales: null,
      price: null,
      ageRating: "",
      releaseDate: "",
      durationSeconds: null,
      tags: [],
      voiceActors: [],
      importStatus: "remote_only",
      workId: null,
      tracks: remoteTracks,
      languageEditions: [],
    }).playbackKey).toBe(first.playbackKey);
  });

  it("includes video with audio in playback and excludes known silent video", () => {
    const videoItem = (id: number, hasAudio: boolean) => ({
      id,
      title: `${id}.mp4`,
      kind: "video",
      hasAudio,
      fingerprint: `video-${id}`,
      durationSeconds: 45,
      progress: null,
      locations: [{
        id: id + 100,
        fileSourceId: 1,
        fileSourceName: "Local",
        locationType: "local",
        path: `library/RJ09999995/${id}.mp4`,
        streamUrl: `/api/media/${id + 100}/stream`,
        downloadUrl: "",
        availability: "available",
        sizeBytes: 4096,
        durationSeconds: 45,
      }],
    } as MediaItem);
    const tree = buildTree([videoItem(1, true), videoItem(2, false)], 1, "RJ09999995");

    expect(flattenTracks(tree).map((track) => track.mediaItemId)).toEqual([1]);
    expect(treeStats(tree)).toMatchObject({ files: 2, video: 2, playable: 1, durationSeconds: 45 });
  });

  it("keeps remote video as video in the player queue", () => {
    const tree = buildRemoteTree([{
      type: "video",
      title: "bonus.mp4",
      hash: "video-hash",
      streamUrl: "/remote/bonus",
      downloadUrl: "",
      sizeBytes: 2048,
      durationSeconds: 30,
      cacheAvailable: false,
      cacheLocationId: null,
      cachePath: "",
      localAvailable: false,
      localLocationId: null,
      localPath: "",
      children: [],
    }] as RemoteTrack[]);

    expect(flattenTracks(tree)).toMatchObject([{ kind: "video", hasAudio: null }]);
  });
});

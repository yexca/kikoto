import { describe, expect, it } from "vitest";

import type { MediaItem, RemoteTrack, WorkProgressSummary } from "@/lib/api";
import {
  buildWorkResumeQueue,
  buildRemoteTree,
  buildTree,
  directoryLyricsAttachments,
  flattenTracks,
  flattenTreeFiles,
  folderPlaybackTracks,
  formatDuration,
  formatTrackDuration,
  remoteSelectablePaths,
  toPreferredPlayerTrack,
  toRemotePreviewPlayerTrack,
  treeStats,
} from "./mediaTreeModel";

function localMediaItem(id: number, kind: "audio" | "text", path: string): MediaItem {
  const pathParts = path.split("/");
  return {
    id,
    parentId: null,
    kind,
    title: pathParts[pathParts.length - 1] ?? path,
    discNo: null,
    trackNo: kind === "audio" ? id : null,
    durationSeconds: kind === "audio" ? 60 : null,
    sizeBytes: 1024,
    fingerprint: `fixture-${id}`,
    progress: null,
    preferredLyricsMediaItemId: null,
    locations: [
      {
        id: id + 100,
        fileSourceId: 1,
        fileSourceCode: "local",
        fileSourceName: "Local",
        locationType: "local",
        path,
        streamUrl: kind === "audio" ? `/api/media/${id + 100}/stream` : "",
        downloadUrl: "",
        remoteHash: "",
        sizeBytes: 1024,
        durationSeconds: kind === "audio" ? 60 : null,
        availability: "available",
        lastCheckedAt: null,
      },
    ],
  };
}

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

  it("builds explicit Resume from the cursor media edition and saved source", () => {
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
          path: "library/RJ09999995/01.mp3",
          streamUrl: "/api/media/21/stream",
          downloadUrl: "",
          availability: "available",
          sizeBytes: 1024,
          durationSeconds: 90,
        },
        {
          id: 31,
          fileSourceId: 2,
          fileSourceName: "Example Remote",
          locationType: "remote_stream",
          path: "RJ09999995/01.mp3",
          streamUrl: "/remote/01",
          downloadUrl: "",
          availability: "remote",
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
    const tracks = flattenTracks(buildTree([item], null, work.primaryCode));
    const cursor = {
      workId: 6,
      mediaWorkId: 7,
      mediaItemId: 11,
      fileSourceId: 2,
      locationId: 31,
      locationType: "remote_stream",
      title: "01.mp3",
      positionSeconds: 42,
      durationSeconds: 90,
      lastPlayedAt: "2026-08-02 10:00:00",
      completed: false,
    } satisfies WorkProgressSummary;

    expect(buildWorkResumeQueue(tracks, work, cursor)).toMatchObject({
      locationId: 31,
      positionSeconds: 42,
      tracks: [{ mediaItemId: 11, locationId: 31, locationType: "remote_stream" }],
    });
    expect(buildWorkResumeQueue(tracks, work, { ...cursor, completed: true })).toBeNull();
    expect(buildWorkResumeQueue(tracks, work, { ...cursor, mediaWorkId: 8 })).toBeNull();
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
      locations: [
        {
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
        },
      ],
    } as MediaItem;

    const tree = buildTree([item], 1, "RJ09999995");

    expect(treeStats(tree)).toMatchObject({ files: 1, playable: 0, sizeBytes: 2048 });
    expect(tree.files[0]).toMatchObject({ kind: "image", locationId: 24, title: "cover.jpg" });
    expect(flattenTracks(tree)).toHaveLength(0);
  });

  it("marks only same-folder matched lyrics as collapsible directory attachments", () => {
    const audio = localMediaItem(1, "audio", "library/RJ00000000/Main/01.mp3");
    const sidecar = localMediaItem(2, "text", "library/RJ00000000/Main/01.lrc");
    const notes = localMediaItem(3, "text", "library/RJ00000000/Main/notes.txt");
    const otherFolder = localMediaItem(4, "text", "library/RJ00000000/Bonus/01.vtt");
    const tree = buildTree([audio, sidecar, notes, otherFolder], 1, "RJ00000000");
    const track = flattenTracks(tree)[0];
    const attachments = directoryLyricsAttachments(tree);

    expect(track).not.toHaveProperty("lyricsMatchPath");
    expect(track.lyricsChoices).toMatchObject([
      { locationId: 102, reason: "same_stem", displayPath: "Main/01.lrc" },
      { locationId: 104, reason: "same_stem", displayPath: "Bonus/01.vtt" },
    ]);
    expect(attachments.hiddenLocationIds).toEqual(new Set([102]));
    expect(attachments.sharedLocationIds.size).toBe(0);
  });

  it("collapses one generic folder lyric without duplicating its attachment row per audio", () => {
    const first = localMediaItem(1, "audio", "library/RJ00000000/Main/01.mp3");
    const second = localMediaItem(2, "audio", "library/RJ00000000/Main/02.mp3");
    const shared = localMediaItem(3, "text", "library/RJ00000000/Main/lyrics.lrc");
    const tree = buildTree([first, second, shared], 1, "RJ00000000");
    const attachments = directoryLyricsAttachments(tree);

    expect(flattenTracks(tree).every((track) => track.lyricsChoices?.[0]?.locationId === 103)).toBe(true);
    expect(attachments.hiddenLocationIds).toEqual(new Set([103]));
    expect(attachments.sharedLocationIds).toEqual(new Set([103]));
  });

  it("builds remote preview paths without turning folders into playable tracks", () => {
    const remoteTracks = [
      {
        type: "folder",
        title: "Disc 1",
        children: [
          {
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
          },
        ],
      },
    ] as RemoteTrack[];

    const tree = buildRemoteTree(remoteTracks);

    expect(flattenTracks(tree)).toHaveLength(1);
    expect(remoteSelectablePaths(tree)).toEqual(["Disc 1/01.mp3"]);
  });

  it("plays folders before same-level files and uses natural numeric order for both", () => {
    const audio = (title: string): RemoteTrack => ({
      type: "audio",
      title,
      hash: "",
      streamUrl: `/remote/${title}`,
      downloadUrl: "",
      durationSeconds: null,
      sizeBytes: null,
      cacheAvailable: false,
      cacheLocationId: null,
      cachePath: "",
      localAvailable: false,
      localLocationId: null,
      localPath: "",
      children: [],
    });
    const folder = (title: string): RemoteTrack => ({
      type: "folder",
      title,
      hash: "",
      streamUrl: "",
      downloadUrl: "",
      durationSeconds: null,
      sizeBytes: null,
      cacheAvailable: false,
      cacheLocationId: null,
      cachePath: "",
      localAvailable: false,
      localLocationId: null,
      localPath: "",
      children: [audio(`folder-${title}.mp3`)],
    });
    const tree = buildRemoteTree([
      audio("10.mp3"),
      folder("10"),
      audio("2.mp3"),
      folder("2"),
      audio("1.mp3"),
      folder("1"),
    ]);

    expect(flattenTracks(tree).map((track) => track.title)).toEqual([
      "folder-1.mp3",
      "folder-2.mp3",
      "folder-10.mp3",
      "1.mp3",
      "2.mp3",
      "10.mp3",
    ]);
    expect(folderPlaybackTracks(tree).map((track) => track.title)).toEqual(["1.mp3", "2.mp3", "10.mp3"]);
  });

  it("uses source, work, and path for remote playback identity", () => {
    const remoteTracks = [
      {
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
      },
    ] as RemoteTrack[];

    const first = flattenTracks(buildRemoteTree(remoteTracks, { sourceId: 7, workCode: "TEST-WORK-001" }))[0];
    const second = flattenTracks(buildRemoteTree(remoteTracks, { sourceId: 8, workCode: "TEST-WORK-002" }))[0];

    expect(first.playbackKey).toBeTruthy();
    expect(second.playbackKey).toBeTruthy();
    expect(first.playbackKey).not.toBe(second.playbackKey);
    expect(
      toRemotePreviewPlayerTrack(first, {
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
      }).playbackKey,
    ).toBe(first.playbackKey);
  });

  it("matches remote sidecar lyrics and keeps the remote URL on the player track", () => {
    const remoteTracks = [
      {
        type: "audio",
        title: "01.wma",
        streamUrl: "https://media.invalid/01.wma",
        downloadUrl: "",
        cacheAvailable: false,
        cacheLocationId: null,
        cachePath: "",
        localAvailable: false,
        localLocationId: null,
        localPath: "",
      },
      {
        type: "text",
        title: "01.lrc",
        streamUrl: "https://media.invalid/01.lrc",
        downloadUrl: "",
        cacheAvailable: false,
        cacheLocationId: null,
        cachePath: "",
        localAvailable: false,
        localLocationId: null,
        localPath: "",
      },
    ] as RemoteTrack[];
    const tree = buildRemoteTree(remoteTracks, { sourceId: 7, workCode: "RJ00000000" });
    const files = flattenTreeFiles(tree);
    const audio = flattenTracks(tree)[0];
    const playerTrack = toRemotePreviewPlayerTrack(
      audio,
      {
        sourceId: 7,
        sourceCode: "remote_a",
        sourceName: "Remote A",
        remoteId: "remote-1",
        primaryCode: "RJ00000000",
        remoteCode: "RJ00000000",
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
      },
      files,
    );
    expect(playerTrack.lyricsChoices?.[0]).toMatchObject({
      title: "01.lrc",
      url: "/api/remote-sources/7/works/RJ00000000/text?path=01.lrc",
    });
    expect(playerTrack.lyricsLocationId).toBeLessThan(0);
  });

  it("includes video with audio in playback and excludes known silent video", () => {
    const videoItem = (id: number, hasAudio: boolean) =>
      ({
        id,
        title: `${id}.mp4`,
        kind: "video",
        hasAudio,
        fingerprint: `video-${id}`,
        durationSeconds: 45,
        progress: null,
        locations: [
          {
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
          },
        ],
      }) as MediaItem;
    const tree = buildTree([videoItem(1, true), videoItem(2, false)], 1, "RJ09999995");

    expect(flattenTracks(tree).map((track) => track.mediaItemId)).toEqual([1]);
    expect(treeStats(tree)).toMatchObject({ files: 2, video: 2, playable: 1, durationSeconds: 45 });
  });

  it("keeps remote video as video in the player queue", () => {
    const tree = buildRemoteTree([
      {
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
      },
    ] as RemoteTrack[]);

    expect(flattenTracks(tree)).toMatchObject([{ kind: "video", hasAudio: null }]);
  });
});

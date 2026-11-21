import { describe, expect, it } from "vitest";

import type { TreeNode, TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { DirectoryRoutingRule } from "@/lib/api";

import { heroPlayback } from "./heroPlaybackModel";

function file(id: number, title: string, kind = "audio"): TreeTrack {
  return {
    mediaItemId: id,
    locationId: id,
    title,
    baseName: title.replace(/\.[^.]+$/, ""),
    sourcePath: title,
    kind,
    folderPath: "",
    locationType: "local",
    streamUrl: `/api/media/${id}/stream`,
    downloadUrl: "",
    assetUrl: "",
    sizeBytes: 1024,
    durationSeconds: kind === "audio" ? 600 : null,
    hasAudio: null,
    availability: "available",
    cacheLocationId: null,
    cachePath: "",
    cacheAvailable: false,
    cacheStreamUrl: "",
    localLocationId: id,
    localPath: title,
    localFolderId: 1,
    localAvailable: true,
    progress: null,
    locations: [],
  };
}

function folder(name: string, files: TreeTrack[], children: TreeNode[] = []): TreeNode {
  return { name, path: name, files, children: new Map(children.map((child) => [child.name, child])) };
}

const rules: DirectoryRoutingRule[] = [];
// The Directory opens on the folder with the most playable files, so the Hero plays that one.
const root = folder(
  "",
  [file(1, "readme.txt", "text")],
  [folder("mp3", [file(2, "01.mp3"), file(3, "02.mp3")]), folder("bonus", [file(4, "bonus.mp3")])],
);

describe("the Hero's primary action", () => {
  it("plays the folder the Directory opens on, from its first track", () => {
    const playback = heroPlayback({ root, routingRules: rules, loading: false, resumable: false });
    expect(playback).toMatchObject({ kind: "play", locationId: 2 });
    expect(playback.kind === "play" && playback.tracks.map((track) => track.title)).toEqual(["01.mp3", "02.mp3"]);
  });

  it("continues saved playback whatever the shown source holds", () => {
    expect(heroPlayback({ root: folder("", []), routingRules: rules, loading: true, resumable: true })).toEqual({
      kind: "resume",
    });
  });

  it("waits while the directory or the saved playback is still loading", () => {
    expect(heroPlayback({ root, routingRules: rules, loading: true, resumable: false })).toEqual({ kind: "loading" });
  });

  it("names why nothing can play instead of offering a disabled Play", () => {
    expect(heroPlayback({ root, routingRules: rules, loading: false, resumable: false, blocked: "offline" })).toEqual({
      kind: "unavailable",
      reason: "offline",
    });
    const onlyText = folder("", [file(1, "readme.txt", "text")]);
    expect(heroPlayback({ root: onlyText, routingRules: rules, loading: false, resumable: false })).toEqual({
      kind: "unavailable",
      reason: "no_media",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import type { MediaFileLocation, MediaItem, SourcePresenceItem, WorkDetail } from "@/lib/api";
import { buildTree, flattenTreeFiles } from "@/features/work-detail/media/mediaTreeModel";
import type { RemoteSourceAvailability, SourceTabInfo } from "@/features/work-detail/source/sourceContextModel";
import { syntheticWorkCode } from "@/test-support/workCode";
import {
  mediaItemsInLocalFolder,
  persistedDetailActionMode,
  persistedDirectoryLoadState,
  persistedFetchTarget,
  persistedTrackingActionState,
} from "./persistedWorkDetailModel";

const workCode = syntheticWorkCode("RJ", 0);
const editionCode = syntheticWorkCode("RJ", 1);

function remote(overrides: Partial<RemoteSourceAvailability["summary"]> = {}, extra = {}) {
  return {
    source: { id: 7, code: "example_remote_a", displayName: "Example Remote A" },
    summary: { sourceId: 7, status: "available", primaryCode: workCode, ...overrides },
    ...extra,
  } as RemoteSourceAvailability;
}

function trackedPresence(overrides: Partial<SourcePresenceItem> = {}) {
  return {
    type: "tracked",
    availability: "available",
    fileSourceId: 7,
    fileSourceCode: "example_remote_a",
    fileSourceName: "Example Remote A",
    ...overrides,
  } as SourcePresenceItem;
}

function work(sourcePresence: SourcePresenceItem[] = []) {
  return { id: 1, primaryCode: workCode, sourcePresence } as WorkDetail;
}

/** A local file location, inside the work folder the server names for it when one holds it. */
function localLocation(id: number, path: string, folder?: { id: number; root: string }): MediaFileLocation {
  return {
    id,
    fileSourceId: 1,
    fileSourceCode: "local",
    fileSourceName: "Local",
    locationType: "local",
    path,
    ...(folder ? { folderId: folder.id, relativePath: path.slice(folder.root.length + 1) } : {}),
    streamUrl: `/api/media/${id}/stream`,
    downloadUrl: "",
    remoteHash: "",
    sizeBytes: 1024,
    durationSeconds: 60,
    availability: "available",
    lastCheckedAt: null,
  };
}

function audioItem(id: number, title: string, locations: MediaFileLocation[]): MediaItem {
  return {
    id,
    parentId: null,
    kind: "audio",
    title,
    discNo: null,
    trackNo: id,
    durationSeconds: 60,
    sizeBytes: 1024,
    fingerprint: `fixture-${id}`,
    progress: null,
    locations,
  };
}

const loadState = {
  work: work(),
  selectedRemoteSource: null,
  selectedRemoteDetail: null,
  selectedRemoteTreeError: "",
  selectedRemoteTreeLoading: false,
  mediaError: "",
  isDirectoryLoading: false,
};

describe("persistedWorkDetailModel", () => {
  it("derives the action mode from the selected source context", () => {
    const trackedTab = { kind: "tracked" } as SourceTabInfo;
    const localTab = { kind: "local" } as SourceTabInfo;

    expect(persistedDetailActionMode(remote(), trackedPresence(), true, trackedTab)).toBe("remote_source");
    expect(persistedDetailActionMode(null, trackedPresence(), true, trackedTab)).toBe("tracked_forked");
    expect(persistedDetailActionMode(null, trackedPresence(), false, trackedTab)).toBe("tracked_unforked");
    expect(persistedDetailActionMode(null, null, false, trackedTab)).toBe("tracked_unforked");
    expect(persistedDetailActionMode(null, null, false, localTab)).toBe("local");
  });

  it("fetches the code the selected source knows the work by", () => {
    const selectedWork = work();

    expect(persistedFetchTarget(remote(), null, editionCode, null, selectedWork, workCode).code).toBe(editionCode);
    expect(
      persistedFetchTarget(null, remote(), "", trackedPresence({ remoteCode: editionCode }), selectedWork, workCode),
    ).toMatchObject({ code: editionCode, remote: { source: { id: 7 } } });
    expect(persistedFetchTarget(null, null, "", trackedPresence(), selectedWork, workCode).code).toBe(workCode);
    expect(persistedFetchTarget(null, null, "", null, null, workCode)).toEqual({ remote: undefined, code: workCode });
  });

  it("offers Track only for a browsable remote that is not tracked yet", () => {
    const detail = { primaryCode: workCode };

    expect(
      persistedTrackingActionState({
        work: work(),
        selectedRemoteSource: remote({}, { detail }),
        selectedRemoteWorkCode: workCode,
        selectedTrackedPresence: null,
      }),
    ).toMatchObject({ canTrackRemote: true, hasTrackedSource: false });

    const presence = trackedPresence({ remoteCode: workCode });
    expect(
      persistedTrackingActionState({
        work: work([presence]),
        selectedRemoteSource: remote({}, { detail }),
        selectedRemoteWorkCode: workCode,
        selectedTrackedPresence: null,
      }),
    ).toMatchObject({ canTrackRemote: false, hasTrackedSource: true, activeTrackedPresence: presence });

    expect(
      persistedTrackingActionState({
        work: work(),
        selectedRemoteSource: remote({ hasTracked: true }, { detail }),
        selectedRemoteWorkCode: workCode,
        selectedTrackedPresence: null,
      }),
    ).toMatchObject({ canTrackRemote: false, selectedRemoteHasTracked: true, activeTrackedPresence: null });
  });

  it("shows the skeleton while a browsable remote has no detail yet", () => {
    expect(persistedDirectoryLoadState({ ...loadState, selectedRemoteSource: remote() })).toMatchObject({
      sourceDetailsLoading: true,
      showSkeleton: true,
    });
    expect(
      persistedDirectoryLoadState({ ...loadState, selectedRemoteSource: remote({ status: "unavailable" }) }),
    ).toMatchObject({ sourceDetailsLoading: false, showSkeleton: false });
  });

  it("reports the selected source's own load error instead of a skeleton", () => {
    expect(
      persistedDirectoryLoadState({
        ...loadState,
        selectedRemoteSource: remote(),
        selectedRemoteTreeError: "remote failed",
        mediaError: "local failed",
      }),
    ).toMatchObject({ mediaLoadError: "remote failed", showSkeleton: false });
    expect(
      persistedDirectoryLoadState({ ...loadState, mediaError: "local failed", isDirectoryLoading: true }),
    ).toMatchObject({ mediaLoadError: "local failed", showSkeleton: false });
  });

  it("lists only one folder's files when a work has two folders on the same source", () => {
    // Neither folder is named after the work, and their names differ only in case.
    const first = { id: 41, root: "disk1/Example Folder" };
    const second = { id: 42, root: "disk1/example folder" };
    // A file at the same path in both folders is one media item with a location in each.
    const items = [
      audioItem(1, "01.mp3", [
        localLocation(11, `${first.root}/audio/01.mp3`, first),
        localLocation(12, `${second.root}/audio/01.mp3`, second),
      ]),
      audioItem(2, "first.mp3", [localLocation(21, `${first.root}/first.mp3`, first)]),
      audioItem(3, "second.mp3", [localLocation(31, `${second.root}/second.mp3`, second)]),
    ];
    const folderFiles = (folderId: number) =>
      flattenTreeFiles(buildTree(mediaItemsInLocalFolder(items, folderId), 1))
        .map((file) => ({ sourcePath: file.sourcePath, localPath: file.localPath }))
        .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));

    expect(folderFiles(first.id)).toEqual([
      { sourcePath: "audio/01.mp3", localPath: `${first.root}/audio/01.mp3` },
      { sourcePath: "first.mp3", localPath: `${first.root}/first.mp3` },
    ]);
    expect(folderFiles(second.id)).toEqual([
      { sourcePath: "audio/01.mp3", localPath: `${second.root}/audio/01.mp3` },
      { sourcePath: "second.mp3", localPath: `${second.root}/second.mp3` },
    ]);
  });
});

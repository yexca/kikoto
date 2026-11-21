import { describe, expect, it } from "vitest";

import type { LocalWorkCleanupWork } from "@/lib/api";

import {
  availableCleanupPage,
  defaultLocalWorkCleanupOptions,
  highRatedWorks,
  localWorkCleanupRequest,
  reconcileSelection,
  selectionSize,
  setLocalWorkCleanupOption,
} from "./localWorkCleanupModel";

function work(workId: number, rating: number | null): LocalWorkCleanupWork {
  return {
    workId,
    primaryCode: `RJ0000000${workId}`,
    title: `Example Work ${workId}`,
    rating,
    listeningStatus: "none",
    sizeBytes: 10,
    fileCount: 1,
    unknownSizeFiles: 0,
    folders: [{ id: workId, path: `RJ0000000${workId}`, online: true }],
    offline: false,
    sourceAvailable: false,
  };
}

describe("local work cleanup options", () => {
  it("offers forgetting only while the rating and Quick mark are both cleared", () => {
    let options = setLocalWorkCleanupOption(defaultLocalWorkCleanupOptions, "forget", true);
    expect(options.forget).toBe(false);

    options = setLocalWorkCleanupOption(options, "clearRating", true);
    options = setLocalWorkCleanupOption(options, "clearMark", true);
    options = setLocalWorkCleanupOption(options, "forget", true);
    expect(options).toEqual({ clearRating: true, clearMark: true, forget: true });

    options = setLocalWorkCleanupOption(options, "clearMark", false);
    expect(options).toEqual({ clearRating: true, clearMark: false, forget: false });
  });
});

describe("local work cleanup selection", () => {
  it("asks again for works rated three stars or more", () => {
    const selection = [work(1, 2), work(2, 3), work(3, null), work(4, 5)];
    expect(highRatedWorks(selection).map((item) => item.workId)).toEqual([2, 4]);
  });

  it("marks the size incomplete while a work has files without a recorded size", () => {
    expect(selectionSize([work(1, 1), work(2, 1)])).toEqual({ bytes: 20, complete: true });
    expect(selectionSize([work(1, 1), { ...work(2, 1), fileCount: 0, sizeBytes: 0 }])).toEqual({
      bytes: 10,
      complete: false,
    });
    expect(selectionSize([{ ...work(1, 1), sizeBytes: 0, unknownSizeFiles: 1 }])).toEqual({
      bytes: 0,
      complete: false,
    });
  });

  it("takes the latest folders on reload and drops works that went offline", () => {
    const selected = new Map([
      [1, work(1, 1)],
      [2, work(2, 1)],
      [3, work(3, 1)],
    ]);
    const moved = { ...work(1, 1), folders: [{ id: 9, path: "Moved/RJ00000001", online: true }] };
    const offline = { ...work(2, 1), offline: true };
    const next = reconcileSelection(selected, [moved, offline]);
    expect([...next.keys()]).toEqual([1, 3]);
    expect(next.get(1)?.folders[0]?.path).toBe("Moved/RJ00000001");
  });

  it("confirms the folders it was shown", () => {
    const request = localWorkCleanupRequest([work(1, 1)], defaultLocalWorkCleanupOptions, false);
    expect(request.works).toEqual([{ workId: 1, folders: [{ id: 1, path: "RJ00000001" }] }]);
    expect(request.forget).toBe(false);
  });
});

describe("local work cleanup paging", () => {
  it("moves back to the last page left after a run empties the shown page", () => {
    expect(availableCleanupPage(2, 51, 50)).toBe(2);
    expect(availableCleanupPage(2, 50, 50)).toBe(1);
    expect(availableCleanupPage(3, 0, 50)).toBe(1);
  });
});

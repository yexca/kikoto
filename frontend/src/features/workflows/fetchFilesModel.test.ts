import { describe, expect, it } from "vitest";

import type { FetchFile } from "@/lib/api";

import { fetchFilePercent, fetchFilesSummary, orderFetchFiles } from "./fetchFilesModel";

function file(path: string, state: FetchFile["state"], sizeBytes: number | null = 100, bytesCurrent = 0): FetchFile {
  return { path, kind: "audio", action: "cache_download", state, sizeBytes, bytesCurrent };
}

describe("fetch file list", () => {
  it("moves the current file to the top and keeps plan order otherwise", () => {
    const files = [file("01.mp3", "done"), file("02.mp3", "done"), file("03.mp3", "active"), file("04.mp3", "pending")];
    expect(orderFetchFiles(files).map((item) => item.path)).toEqual(["03.mp3", "01.mp3", "02.mp3", "04.mp3"]);
    expect(fetchFilesSummary(files)).toEqual({ done: 2, total: 4, current: files[2] });
  });

  it("keeps a failed file in view after the run stops", () => {
    const files = [file("01.mp3", "done"), file("02.mp3", "failed"), file("03.mp3", "pending")];
    expect(orderFetchFiles(files)[0].path).toBe("02.mp3");
  });

  it("reports progress only for files with a known size", () => {
    expect(fetchFilePercent(file("01.mp3", "active", 200, 50))).toBe(25);
    expect(fetchFilePercent(file("02.mp3", "active", null, 50))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { filterRemoteFetchPaths, parseFetchExtensions } from "./remoteFetchFilters";

describe("Fetch extension exclusions", () => {
  it("normalizes dotted, mixed-case and repeated extensions", () => {
    expect(parseFetchExtensions(" .WAV, flac；wav\n .7z，OPUS ")).toEqual(["wav", "flac", "7z", "opus"]);
  });

  it("excludes by the filename's final extension while retaining other files", () => {
    const paths = ["Disc.wav/01.MP3", "Disc/01.WAV", "cover.JPG", "notes", "backup.wav.zip"];
    expect(filterRemoteFetchPaths(paths, [".wav", "JPG"])).toEqual(["Disc.wav/01.MP3", "notes", "backup.wav.zip"]);
  });

  it("keeps every file by default and returns an empty selection when every type is excluded", () => {
    const paths = ["01.wav", "02.WAV"];
    expect(filterRemoteFetchPaths(paths)).toEqual(paths);
    expect(filterRemoteFetchPaths(paths, ["wav"])).toEqual([]);
  });
});

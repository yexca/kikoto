import { describe, expect, it } from "vitest";

import type { FileDisplayNames } from "@/lib/api";
import {
  displayNameChange,
  displayNameInvalid,
  displayNameRows,
  displayNameValue,
  pasteDisplayNames,
  realNamesText,
} from "./fileDisplayNamesModel";

const entries: Pick<FileDisplayNames, "folders" | "files"> = {
  folders: [
    { path: "mp3", names: { "zh-cn": "音频" } },
    { path: "mp3/SE", names: {} },
  ],
  files: [
    { mediaItemId: 3, path: "mp3/10 end.mp3", names: {} },
    { mediaItemId: 1, path: "readme.txt", names: {} },
    { mediaItemId: 2, path: "mp3/2 start.mp3", names: { "zh-cn": "开始" } },
    { mediaItemId: 4, path: "mp3/SE/01.mp3", names: {} },
  ],
};

describe("fileDisplayNamesModel", () => {
  it("lists folders before their files in natural order, with each file's extension apart", () => {
    const rows = displayNameRows(entries);
    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ["mp3", 0],
      ["mp3/SE", 1],
      ["mp3/SE/01.mp3", 2],
      ["mp3/2 start.mp3", 1],
      ["mp3/10 end.mp3", 1],
      ["readme.txt", 0],
    ]);
    expect(rows[3]).toMatchObject({ baseName: "2 start", extension: ".mp3", mediaItemId: 2 });
    expect(realNamesText(rows)).toBe("mp3\nSE\n01\n2 start\n10 end\nreadme");
  });

  it("saves only names that differ from the stored ones, an emptied name as a removal", () => {
    const rows = displayNameRows(entries);
    const drafts = { "folder:mp3": " 音频 ", "file:2": "", "file:3": "结束 ", "folder:mp3/SE": "" };
    expect(displayNameValue(rows[0], {}, "zh-cn")).toBe("音频");
    expect(displayNameChange(rows, drafts, "zh-cn")).toEqual({
      language: "zh-cn",
      files: [
        { mediaItemId: 2, name: "" },
        { mediaItemId: 3, name: "结束" },
      ],
      folders: [],
    });
    expect(displayNameChange(rows, { "folder:mp3": "音频" }, "zh-cn")).toBeNull();
  });

  it("fills pasted lines into the rows in order and skips blank lines", () => {
    const rows = displayNameRows(entries);
    const drafts = pasteDisplayNames(rows, { "file:1": "kept" }, "Audio\r\n\r\nFirst\n\nLast\nAbout\nextra\n");
    expect(drafts).toEqual({
      "folder:mp3": "Audio",
      "file:4": "First",
      "file:3": "Last",
      "file:1": "About",
    });
  });

  it("refuses names that are not one path segment", () => {
    expect(displayNameInvalid("开始")).toBe(false);
    expect(displayNameInvalid("")).toBe(false);
    expect(displayNameInvalid("a/b")).toBe(true);
    expect(displayNameInvalid("a\\b")).toBe(true);
    expect(displayNameInvalid("..")).toBe(true);
    expect(displayNameInvalid("x".repeat(256))).toBe(true);
  });
});

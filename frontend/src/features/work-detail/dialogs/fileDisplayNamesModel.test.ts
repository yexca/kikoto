import { describe, expect, it } from "vitest";

import type { FileDisplayNames } from "@/lib/api";
import {
  displayNameChange,
  displayNameChanged,
  displayNameGroups,
  displayNameInvalid,
  displayNameMatches,
  displayNameRows,
  displayNamesText,
  displayNameValue,
  namedRowCount,
  realNamesText,
  textDisplayNames,
  textLines,
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
  it("lists each folder, its files, then its subfolders in natural order, with each file's extension apart", () => {
    const rows = displayNameRows(entries);
    expect(rows.map((row) => [row.path, row.depth])).toEqual([
      ["readme.txt", 0],
      ["mp3", 0],
      ["mp3/2 start.mp3", 1],
      ["mp3/10 end.mp3", 1],
      ["mp3/SE", 1],
      ["mp3/SE/01.mp3", 2],
    ]);
    expect(rows[2]).toMatchObject({ baseName: "2 start", extension: ".mp3", mediaItemId: 2 });
    expect(realNamesText(rows)).toBe("readme\nmp3\n2 start\n10 end\nSE\n01");
  });

  it("groups the rows by the folder they are in", () => {
    const groups = displayNameGroups(displayNameRows(entries));
    expect(groups.map((group) => [group.path, group.folder?.key ?? null, group.files.map((file) => file.key)])).toEqual(
      [
        ["", null, ["file:1"]],
        ["mp3", "folder:mp3", ["file:2", "file:3"]],
        ["mp3/SE", "folder:mp3/SE", ["file:4"]],
      ],
    );
    // A folder without a row of its own still groups its files.
    expect(
      displayNameGroups(displayNameRows({ folders: [], files: [{ mediaItemId: 9, path: "a/b.mp3", names: {} }] })),
    ).toMatchObject([{ path: "a", folder: null, files: [{ key: "file:9" }] }]);
  });

  it("filters by real path or stored name and counts the names the drafts leave", () => {
    const rows = displayNameRows(entries);
    expect(rows.filter((row) => displayNameMatches(row, " START ", "zh-cn")).map((row) => row.key)).toEqual(["file:2"]);
    expect(rows.filter((row) => displayNameMatches(row, "音频", "zh-cn")).map((row) => row.key)).toEqual([
      "folder:mp3",
    ]);
    expect(rows.filter((row) => displayNameMatches(row, "音频", "ja-jp"))).toEqual([]);
    expect(namedRowCount(rows, {}, "zh-cn")).toBe(2);
    expect(namedRowCount(rows, { "file:2": " ", "file:1": "说明" }, "zh-cn")).toBe(2);
    expect(displayNameChanged(rows[1], { "folder:mp3": " 音频" }, "zh-cn")).toBe(false);
    expect(displayNameChanged(rows[1], { "folder:mp3": "" }, "zh-cn")).toBe(true);
  });

  it("saves only names that differ from the stored ones, an emptied name as a removal", () => {
    const rows = displayNameRows(entries);
    const drafts = { "folder:mp3": " 音频 ", "file:2": "", "file:3": "结束 ", "folder:mp3/SE": "" };
    expect(displayNameValue(rows[1], {}, "zh-cn")).toBe("音频");
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

  it("writes one name per row and reads edited text back line by line", () => {
    const rows = displayNameRows(entries);
    const base = { "file:1": "说明" };
    const text = displayNamesText(rows, base, "zh-cn");
    expect(text).toBe("说明\n音频\n开始\n\n\n");
    // The text has a line for every row, the unnamed last ones included.
    expect(textLines(text, rows.length)).toHaveLength(rows.length);
    expect(textDisplayNames(rows, {}, text)).toEqual({
      "file:1": "说明",
      "folder:mp3": "音频",
      "file:2": "开始",
      "file:3": "",
      "folder:mp3/SE": "",
      "file:4": "",
    });
    // An empty line leaves its row the real name; lines past the last row are ignored.
    expect(textDisplayNames(rows, base, "About\r\n\r\nFirst\n\nLast\nOne\nextra\n")).toEqual({
      "file:1": "About",
      "folder:mp3": "",
      "file:2": "First",
      "file:3": "",
      "folder:mp3/SE": "Last",
      "file:4": "One",
    });
    // Rows past the last line keep the drafts the text started with.
    expect(textDisplayNames(rows, { ...base, "file:4": "kept" }, "readme")).toEqual({
      "file:1": "readme",
      "file:4": "kept",
    });
    // A pasted list's final line break is not a line of its own, unless an entry is left for it.
    expect(textLines("a\r\n\nb\n", 3)).toEqual(["a", "", "b"]);
    expect(textLines("a\r\n\nb\n", 4)).toEqual(["a", "", "b", ""]);
    expect(textLines("", 1)).toEqual([""]);
    expect(textLines("", 0)).toEqual([]);
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

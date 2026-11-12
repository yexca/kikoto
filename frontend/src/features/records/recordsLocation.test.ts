import { describe, expect, it } from "vitest";

import {
  closeOverlayNavigation,
  historyStateWithRecordTrail,
  openCrumbNavigation,
  openFolderNavigation,
  openFolderVideoNavigation,
  openOverlayNavigation,
  readRecordsLocation,
  recordTrailFromState,
  recordsHref,
  stepOverlayNavigation,
  updateViewNavigation,
  type RecordCrumb,
} from "./recordsLocation";

const family: RecordCrumb = { id: 3, name: "Family" };
const trip: RecordCrumb = { id: 7, name: "Summer Trip", posterUrl: "/poster", backdropUrl: "/backdrop" };

describe("Record location", () => {
  it("round-trips the folder, view, and overlay through the URL and keeps defaults out of it", () => {
    expect(recordsHref(readRecordsLocation(""))).toBe("/records");
    const location = readRecordsLocation("?folder=7&kind=photos&sort=name-desc&photo=12");
    expect(location).toEqual({
      folderId: 7,
      filter: "photos",
      sort: "name-desc",
      overlay: { kind: "photo", assetId: 12 },
    });
    expect(recordsHref(location)).toBe("/records?folder=7&kind=photos&sort=name-desc&photo=12");
  });

  it("ignores malformed values instead of opening another folder", () => {
    expect(readRecordsLocation("?folder=-2&kind=music&sort=size&play=1.5")).toEqual({
      folderId: 0,
      filter: "all",
      sort: "name",
      overlay: null,
    });
  });

  it("opens a child folder as a new entry that carries its breadcrumb trail", () => {
    const current = readRecordsLocation("?folder=3&kind=videos");
    const navigation = openFolderNavigation(current, [family], trip);
    expect(navigation).toEqual({
      mode: "push",
      href: "/records?folder=7&kind=videos",
      state: historyStateWithRecordTrail({}, [family, trip]),
    });
    if (navigation.mode === "back") throw new Error("expected a push");
    expect(recordTrailFromState(navigation.state, 7)).toEqual([family, trip]);
  });

  it("restores a trail only for the folder the entry names", () => {
    const state = historyStateWithRecordTrail({ other: true }, [family, trip]);
    expect(recordTrailFromState(state, 7)).toEqual([family, trip]);
    expect(recordTrailFromState(state, 3)).toBeNull();
    expect(recordTrailFromState(null, 7)).toBeNull();
    expect(recordTrailFromState(null, 0)).toEqual([]);
  });

  it("opens a breadcrumb ancestor, or the root, as a new entry", () => {
    const current = readRecordsLocation("?folder=7&play=4");
    expect(openCrumbNavigation(current, [family, trip], 0)).toMatchObject({
      mode: "push",
      href: "/records?folder=3",
    });
    expect(openCrumbNavigation(current, [family, trip], -1)).toMatchObject({ mode: "push", href: "/records" });
  });

  it("changes the filter and order in place", () => {
    const current = readRecordsLocation("?folder=7");
    expect(updateViewNavigation(current, { kept: 1 }, { sort: "name-desc" })).toEqual({
      mode: "replace",
      href: "/records?folder=7&sort=name-desc",
      state: { kept: 1 },
    });
  });

  it("closes an overlay it opened by going back to the folder entry below it", () => {
    const folderState = historyStateWithRecordTrail({}, [family, trip]);
    const folder = readRecordsLocation("?folder=7");
    const open = openOverlayNavigation(folder, folderState, { kind: "video", assetId: 21 });
    expect(open).toMatchObject({ mode: "push", href: "/records?folder=7&play=21" });
    if (open.mode === "back") throw new Error("expected a push");

    const playing = readRecordsLocation("?folder=7&play=21");
    const step = stepOverlayNavigation(playing, open.state, 22);
    expect(step).toEqual({ mode: "replace", href: "/records?folder=7&play=22", state: open.state });

    const close = closeOverlayNavigation(readRecordsLocation("?folder=7&play=22"), open.state);
    expect(close.mode).toBe("back");
    if (close.mode !== "back") throw new Error("expected back");
    expect(close.fallback.href).toBe("/records?folder=7");
    expect(recordTrailFromState(close.fallback.state, 7)).toEqual([family, trip]);
  });

  it("replaces a pasted overlay link with its folder, since no folder entry lies below it", () => {
    const pasted = readRecordsLocation("?folder=7&photo=30");
    expect(closeOverlayNavigation(pasted, null)).toEqual({ mode: "replace", href: "/records?folder=7", state: {} });
  });

  it("opens a Continue watching video over its own folder, and closing it goes back to the root", () => {
    const root = readRecordsLocation("?kind=photos");
    const open = openFolderVideoNavigation(root, 7, 21);
    expect(open).toMatchObject({ mode: "push", href: "/records?folder=7&kind=photos&play=21" });
    if (open.mode === "back") throw new Error("expected a push");
    expect(recordTrailFromState(open.state, 7)).toBeNull();
    expect(closeOverlayNavigation(readRecordsLocation("?folder=7&play=21"), open.state).mode).toBe("back");
  });

  it("moves an open overlay instead of stacking a second one", () => {
    const playing = readRecordsLocation("?folder=7&play=21");
    expect(openOverlayNavigation(playing, {}, { kind: "video", assetId: 23 })).toMatchObject({
      mode: "replace",
      href: "/records?folder=7&play=23",
    });
  });
});

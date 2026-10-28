import { describe, expect, it, vi } from "vitest";

import {
  chooseWorkCardMode,
  discoverCardLayout,
  DISCOVER_LAYOUT_STORE,
  LIBRARY_LAYOUT_STORE,
  storedWorkCollectionLayout,
  workCardLayout,
  workCollectionStyle,
} from "./workCollectionLayoutModel";

const defaults = { mobileColumns: "auto", desktopColumns: "auto" } as const;

describe("stored work collection layout", () => {
  it("starts with full cards at both widths", () => {
    expect(storedWorkCollectionLayout(null, defaults)).toEqual({
      mobileColumns: "auto",
      desktopColumns: "auto",
      mobileCardMode: "full",
      desktopCardMode: "full",
    });
  });

  it("keeps a card mode per width and drops values it does not know", () => {
    const stored = JSON.stringify({ mobileCardMode: "mini", desktopCardMode: "dense", desktopColumns: 6 });
    expect(storedWorkCollectionLayout(stored, defaults)).toEqual({
      mobileColumns: "auto",
      desktopColumns: 6,
      mobileCardMode: "mini",
      desktopCardMode: "full",
    });
  });

  it("reads a stored compact switch as the compact phone mode only", () => {
    const layout = storedWorkCollectionLayout(JSON.stringify({ mobileColumns: 2, mobileCompact: true }), defaults);
    expect(layout.mobileCardMode).toBe("compact");
    expect(layout.desktopCardMode).toBe("full");
  });

  it("falls back to the defaults when the stored value is not JSON", () => {
    expect(storedWorkCollectionLayout("{", defaults).mobileCardMode).toBe("full");
  });

  it("starts Discover with compact cards while keeping a stored choice", () => {
    const { storageKey, cardMode } = DISCOVER_LAYOUT_STORE;
    expect(storageKey).not.toBe(LIBRARY_LAYOUT_STORE.storageKey);
    expect(storedWorkCollectionLayout(null, defaults, cardMode)).toMatchObject({
      mobileCardMode: "compact",
      desktopCardMode: "compact",
    });
    expect(
      storedWorkCollectionLayout(JSON.stringify({ desktopCardMode: "full" }), defaults, cardMode).desktopCardMode,
    ).toBe("full");
  });
});

describe("work card layout", () => {
  it("uses the regular card for the full mode", () => {
    expect(workCardLayout("full", true, "auto")).toBeNull();
    expect(workCardLayout("full", false, 2)).toBeNull();
  });

  it("shows compact cards as rows in one phone column and as tiles elsewhere", () => {
    expect(workCardLayout("compact", false, "auto")).toBe("row");
    expect(workCardLayout("compact", false, 1)).toBe("row");
    expect(workCardLayout("compact", false, 2)).toBe("tile");
    expect(workCardLayout("compact", true, 1)).toBe("tile");
  });

  it("shows mini cards as covers at every width", () => {
    expect(workCardLayout("mini", false, 1)).toBe("cover");
    expect(workCardLayout("mini", true, "auto")).toBe("cover");
  });

  it("keeps Discover's compact cards as rows on wide screens, with tiles only in two phone columns", () => {
    expect(discoverCardLayout("compact", true, 2)).toBe("row");
    expect(discoverCardLayout("compact", false, "auto")).toBe("row");
    expect(discoverCardLayout("compact", false, 2)).toBe("tile");
    expect(discoverCardLayout("full", true, "auto")).toBeNull();
    expect(discoverCardLayout("mini", true, "auto")).toBe("cover");
  });
});

describe("choosing a card mode", () => {
  const targets = () => ({
    setMode: vi.fn(),
    setDesktopColumns: vi.fn(),
    pageSizeOptions: [24, 48, 96],
    setPageSize: vi.fn(),
    setCoverSources: vi.fn(),
  });

  it("returns columns to automatic and applies each mode's page size and cover source marks", () => {
    const expected = {
      full: [24, "auto"],
      compact: [24, "auto"],
      mini: [48, "never"],
    } as const;
    for (const [mode, [pageSize, coverSources]] of Object.entries(expected)) {
      const current = mode === "full" ? "mini" : "full";
      const applied = targets();
      chooseWorkCardMode(current, mode as keyof typeof expected, applied);
      expect(applied.setMode).toHaveBeenCalledWith(mode);
      expect(applied.setDesktopColumns).toHaveBeenCalledWith("auto");
      expect(applied.setPageSize).toHaveBeenCalledWith(pageSize);
      expect(applied.setCoverSources).toHaveBeenCalledWith(coverSources);
    }
  });

  it("keeps the other settings when the current mode is chosen again", () => {
    const applied = targets();
    chooseWorkCardMode("mini", "mini", applied);
    expect(applied.setMode).toHaveBeenCalledWith("mini");
    expect(applied.setDesktopColumns).not.toHaveBeenCalled();
    expect(applied.setPageSize).not.toHaveBeenCalled();
    expect(applied.setCoverSources).not.toHaveBeenCalled();
  });

  it("keeps a page size the page does not offer", () => {
    const applied = { ...targets(), pageSizeOptions: [5, 10, 15] };
    chooseWorkCardMode("full", "mini", applied);
    expect(applied.setPageSize).not.toHaveBeenCalled();
    expect(applied.setDesktopColumns).toHaveBeenCalledWith("auto");
  });
});

describe("work collection grid", () => {
  it("pairs cover cards in automatic phone columns and keeps every other choice", () => {
    const regular = workCollectionStyle("auto", "auto") as Record<string, string>;
    const covers = workCollectionStyle("auto", "auto", "cover") as Record<string, string>;
    expect(regular["--mobile-grid-template"]).toContain("16rem");
    expect(covers["--mobile-grid-template"]).toBe("repeat(2, minmax(0, 1fr))");
    expect(workCollectionStyle(1, 6, "cover")).toEqual(workCollectionStyle(1, 6));
  });

  it("fits up to five full, three row, six compact, and seven mini cards in automatic wide-screen columns", () => {
    const desktop = (layout: "row" | "tile" | "cover" | null) =>
      (workCollectionStyle("auto", "auto", layout) as Record<string, string>)["--desktop-grid-template"];
    expect(desktop("row")).toBe("repeat(auto-fill, minmax(min(100%, max(22rem, calc((100% - 2rem) / 3))), 1fr))");
    expect(desktop(null)).toBe("repeat(auto-fill, minmax(min(100%, max(16rem, calc((100% - 4rem) / 5))), 1fr))");
    expect(desktop("tile")).toBe("repeat(auto-fill, minmax(min(100%, max(13rem, calc((100% - 5rem) / 6))), 1fr))");
    expect(desktop("cover")).toBe("repeat(auto-fill, minmax(min(100%, max(11rem, calc((100% - 6rem) / 7))), 1fr))");
  });
});

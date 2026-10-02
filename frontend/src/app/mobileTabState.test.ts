import { afterEach, describe, expect, it, vi } from "vitest";

import { mobileTabSnapshotFromValue, readMobileTabSnapshot, writeMobileTabSnapshot } from "./mobileTabState";
import { historyStateWithReturn } from "../lib/browserHistory";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe("mobile tab state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps an internal detail route with restorable history state", () => {
    expect(
      mobileTabSnapshotFromValue(
        {
          page: "library",
          location: "/RJ00000000?view=tracked",
          state: { returnTo: "/?q=voice", workPreview: { primaryCode: "RJ00000000" } },
          scrollY: 320,
        },
        "library",
      ),
    ).toEqual({
      page: "library",
      location: "/RJ00000000?view=tracked",
      state: { returnTo: "/?q=voice", workPreview: { primaryCode: "RJ00000000" } },
      scrollY: 320,
    });
  });

  it("rejects another page, an external URL, or an invalid scroll position", () => {
    expect(
      mobileTabSnapshotFromValue({ page: "voice-actors", location: "/voices/7", state: {}, scrollY: 0 }, "library"),
    ).toBeNull();
    expect(
      mobileTabSnapshotFromValue(
        { page: "library", location: "https://example.invalid/RJ00000000", state: {}, scrollY: 0 },
        "library",
      ),
    ).toBeNull();
    expect(
      mobileTabSnapshotFromValue({ page: "library", location: "/RJ00000000", state: {}, scrollY: -1 }, "library"),
    ).toBeNull();
  });

  it("round-trips snapshots through session storage and normalizes the location", () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal("window", { sessionStorage });

    writeMobileTabSnapshot(
      "example-server:user-1",
      "library",
      " /RJ00000000?view=tracked#media ",
      { tab: "media" },
      240,
    );
    expect(readMobileTabSnapshot("example-server:user-1", "library")).toEqual({
      page: "library",
      location: "/RJ00000000?view=tracked#media",
      state: { tab: "media" },
      scrollY: 240,
    });
    expect(readMobileTabSnapshot("example-server:user-1", "favorites")).toBeNull();
  });

  it.each(["/circles/RG00000001", "/circles/RG00000001/series/example", "/voices/7", "/favorites"])(
    "keeps the Library snapshot when a work is opened from %s and rejects an already saved foreign detail",
    (returnTo) => {
      const sessionStorage = memoryStorage();
      vi.stubGlobal("window", { sessionStorage });
      writeMobileTabSnapshot(
        "example-server:user-1",
        "library",
        "/?q=Example",
        { libraryBrowseState: { page: 2 } },
        480,
      );
      writeMobileTabSnapshot("example-server:user-1", "library", "/RJ00000000", { returnTo }, 0);
      expect(readMobileTabSnapshot("example-server:user-1", "library")).toEqual({
        page: "library",
        location: "/?q=Example",
        state: { libraryBrowseState: { page: 2 } },
        scrollY: 480,
      });
      const key = sessionStorage.key(0)!;
      sessionStorage.setItem(
        key,
        JSON.stringify({ page: "library", location: "/RJ00000000", state: { returnTo }, scrollY: 0 }),
      );
      expect(readMobileTabSnapshot("example-server:user-1", "library")).toBeNull();
    },
  );

  it("keeps the originating workspace through a nested work return entry", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/RJ00000000", search: "", hash: "" },
      history: { state: { returnTo: "/voices/7" } },
      scrollY: 120,
    });
    expect(
      mobileTabSnapshotFromValue(
        {
          page: "library",
          location: "/RJ00000001",
          state: historyStateWithReturn("/RJ00000000", "Back to work"),
          scrollY: 0,
        },
        "library",
      ),
    ).toBeNull();
  });

  it("drops oversized state and tolerates unavailable session storage", () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal("window", { sessionStorage });
    writeMobileTabSnapshot("example-server:user-1", "library", "/", { payload: "x".repeat(200 * 1024) }, 1);
    expect(readMobileTabSnapshot("example-server:user-1", "library")?.state).toEqual({});

    const unavailable = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    vi.stubGlobal("window", { sessionStorage: unavailable });
    expect(() => writeMobileTabSnapshot("example-server:user-1", "library", "/", {}, 0)).not.toThrow();
    expect(readMobileTabSnapshot("example-server:user-1", "library")).toBeNull();
  });
});

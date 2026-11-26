import { afterEach, describe, expect, it, vi } from "vitest";

import { writeMobileTabSnapshot } from "./mobileTabState";
import { openPlayingWorkDetail } from "./playingWorkNavigation";
import { historyStateWithWorkDetailOwner, workDetailOwnerPage } from "./workDetailNavigation";
import { isMobileTabResumeHistoryState } from "./browserHistory";

const storageScope = "example-server:user-1";

function stubBrowser(location: string, state: unknown = {}) {
  const url = new URL(location, "https://kikoto.invalid");
  const values = new Map<string, string>();
  const pushState = vi.fn();
  vi.stubGlobal("window", {
    location: { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash },
    history: { state, pushState },
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    scrollY: 0,
    dispatchEvent: vi.fn(),
  });
  return pushState;
}

function open(originPage: string | undefined, returnToOrigin = true, originWorkLocation?: string) {
  openPlayingWorkDetail({
    workCode: "RJ00000000",
    origin: { originPage, originWorkLocation },
    returnToOrigin,
    storageScope,
    returnLabel: "Back",
  });
}

describe("openPlayingWorkDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resumes the origin destination's own entry while it still shows the work", () => {
    const pushState = stubBrowser("/?q=sample");
    const detailState = historyStateWithWorkDetailOwner({ returnTo: "/favorites?q=sample" }, "favorites");
    writeMobileTabSnapshot(storageScope, "favorites", "/RJ00000000?view=local", detailState, 240);

    open("favorites");

    expect(pushState).toHaveBeenCalledTimes(1);
    const [state, , location] = pushState.mock.calls[0];
    expect(location).toBe("/RJ00000000?view=local");
    expect(state).toMatchObject({ returnTo: "/favorites?q=sample" });
    expect(isMobileTabResumeHistoryState(state)).toBe(true);
    expect(workDetailOwnerPage(state)).toBe("favorites");
  });

  it("opens the work as the origin's own when that destination shows something else", () => {
    const pushState = stubBrowser("/?q=sample");
    writeMobileTabSnapshot(storageScope, "favorites", "/favorites", {}, 0);

    open("favorites");

    const [state, , location] = pushState.mock.calls[0];
    expect(location).toBe("/RJ00000000");
    expect(state).toMatchObject({ returnTo: "/?q=sample", returnLabel: "Back" });
    expect(workDetailOwnerPage(state)).toBe("favorites");
  });

  it("opens the work in the current page on wide layouts and for an unrecorded origin", () => {
    for (const [originPage, returnToOrigin] of [
      ["favorites", false],
      [undefined, true],
      ["unknown", true],
    ] as const) {
      const pushState = stubBrowser("/circles/RG00000001");
      open(originPage, returnToOrigin);
      const [state, , location] = pushState.mock.calls[0];
      expect(location).toBe("/RJ00000000");
      // The entry names no owner, so the history layer records the current page.
      expect(workDetailOwnerPage(state)).toBe("library");
      expect(state).toMatchObject({ returnTo: "/circles/RG00000001" });
    }
  });

  it("follows the location a track of another edition was queued from", () => {
    const pushState = stubBrowser("/?q=sample");
    const detailState = historyStateWithWorkDetailOwner({ returnTo: "/favorites" }, "favorites");
    writeMobileTabSnapshot(storageScope, "favorites", "/RJ00000001?view=local", detailState, 0);

    open("favorites", true, "/RJ00000001?view=local");
    expect(pushState.mock.calls[0][2]).toBe("/RJ00000001?view=local");
    expect(isMobileTabResumeHistoryState(pushState.mock.calls[0][0])).toBe(true);

    writeMobileTabSnapshot(storageScope, "favorites", "/favorites", {}, 0);
    open("favorites", true, "/RJ00000001?view=local");
    expect(pushState.mock.calls[1][2]).toBe("/RJ00000001?view=local");
    expect(workDetailOwnerPage(pushState.mock.calls[1][0])).toBe("favorites");

    // A recorded location that is not a work detail falls back to the track's own code.
    open("favorites", true, "https://example.invalid/RJ00000001");
    expect(pushState.mock.calls[2][2]).toBe("/RJ00000000");
  });

  it("stays on a detail that already shows the work", () => {
    const pushState = stubBrowser("/rj00000000?view=tracked", historyStateWithWorkDetailOwner({}, "circles"));
    open("favorites");
    expect(pushState).not.toHaveBeenCalled();
  });
});

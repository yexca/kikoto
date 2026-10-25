import { afterEach, describe, expect, it, vi } from "vitest";

import { appPageForLocation, historyStateForNavigation } from "./appRoutes";
import { historyStateWithWorkDetailOwner, workDetailOwnerPage } from "./workDetailNavigation";

function stubLocation(location: string, state: unknown) {
  const url = new URL(location, "https://kikoto.invalid");
  vi.stubGlobal("window", {
    location: { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash },
    history: { state },
  });
}

describe("appPageForLocation", () => {
  it("resolves a list or entity location from its path", () => {
    expect(appPageForLocation("/?q=sample", {})).toBe("library");
    expect(appPageForLocation("/favorites", {})).toBe("favorites");
    expect(appPageForLocation("/circles/RG00000001/series/example", {})).toBe("circles");
    expect(appPageForLocation("/voices/00000001", {})).toBe("voice-actors");
    expect(appPageForLocation("/voices/local-7", {})).toBe("voice-actors");
    expect(appPageForLocation("/voices/local-07", {})).toBe("not-found");
    expect(appPageForLocation("/voices/Example%20Voice", {})).toBe("not-found");
    expect(appPageForLocation("/library/unknown/deeper", {})).toBe("not-found");
  });

  it("gives Discover its own address and the Subscriptions address it redirects from", () => {
    expect(appPageForLocation("/discover?view=watch", {})).toBe("subscriptions");
    expect(appPageForLocation("/subscriptions?view=rankings", {})).toBe("subscriptions");
  });

  it("gives work detail to the page that opened it and a direct link to Library", () => {
    const owned = historyStateWithWorkDetailOwner({}, "favorites");
    expect(appPageForLocation("/RJ00000000", owned)).toBe("favorites");
    expect(appPageForLocation("/REMOTE-SAMPLE?source=4", owned)).toBe("favorites");
    expect(appPageForLocation("/RJ00000000", null)).toBe("library");
    expect(appPageForLocation("/RJ00000000", { __kikotoWorkDetailOwner: "unknown" })).toBe("library");
    // The owner only applies to work detail entries.
    expect(appPageForLocation("/voices/00000001", owned)).toBe("voice-actors");
  });
});

describe("historyStateForNavigation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records the page a work is opened from", () => {
    stubLocation("/circles/RG00000001", {});
    expect(workDetailOwnerPage(historyStateForNavigation({ returnTo: "/circles/RG00000001" }, "/RJ00000000"))).toBe(
      "circles",
    );
  });

  it("keeps a nested work in the page that owns the work it was opened from", () => {
    stubLocation("/RJ00000000", historyStateWithWorkDetailOwner({}, "voice-actors"));
    expect(workDetailOwnerPage(historyStateForNavigation({}, "/RJ00000001"))).toBe("voice-actors");
  });

  it("keeps an owner the entry already names and the owner of an entry updated in place", () => {
    stubLocation("/favorites", {});
    const resumed = historyStateWithWorkDetailOwner({}, "library");
    expect(workDetailOwnerPage(historyStateForNavigation(resumed, "/RJ00000000"))).toBe("library");

    stubLocation("/RJ00000000", historyStateWithWorkDetailOwner({}, "favorites"));
    expect(workDetailOwnerPage(historyStateForNavigation({ updated: true }, undefined))).toBe("favorites");
  });

  it("leaves other entries unchanged", () => {
    stubLocation("/favorites", {});
    const state = { favoritesBrowseState: { page: 2 } };
    expect(historyStateForNavigation(state, "/favorites?q=sample")).toBe(state);
  });
});

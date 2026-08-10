import { afterEach, describe, expect, it, vi } from "vitest";

import { NAVIGATION_EVENT, navigateToWorkspaceUp } from "./browserHistory";

describe("workspace Up navigation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replaces a cross-workspace return with the mobile workspace list", () => {
    const browser = stubWindow({ returnTo: "/favorites?q=voice" });

    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: "/?q=library",
      fallbackState: { library: "browse" },
      isWorkspaceListLocation: (location) => location.startsWith("/?"),
    });

    expect(browser.back).not.toHaveBeenCalled();
    expect(browser.replaceState).toHaveBeenCalledWith({ library: "browse" }, "", "/?q=library");
    expect(browser.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: NAVIGATION_EVENT }));
  });

  it("uses history when the mobile return already belongs to the workspace list", () => {
    const browser = stubWindow({ returnTo: "/voices?q=example" });

    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: "/voices",
      isWorkspaceListLocation: (location) => location.startsWith("/voices") && !location.startsWith("/voices/"),
    });

    expect(browser.back).toHaveBeenCalledOnce();
    expect(browser.replaceState).not.toHaveBeenCalled();
  });

  it("restores the captured list entry when the detail came from a mobile tab snapshot", () => {
    const browser = stubWindow({
      returnTo: "/voices?q=example",
      __kikotoMobileTabResume: true,
      __kikotoReturnEntry: {
        location: "/voices?q=example",
        state: { voiceBrowse: true },
        scrollY: 240,
      },
    });

    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: "/voices",
      isWorkspaceListLocation: (location) => location.startsWith("/voices") && !location.startsWith("/voices/"),
    });

    expect(browser.back).not.toHaveBeenCalled();
    expect(browser.pushState).toHaveBeenCalledWith(
      {
        voiceBrowse: true,
        __kikotoMobileTabResume: true,
        __kikotoRequestedScrollY: 240,
      },
      "",
      "/voices?q=example",
    );
  });

  it("keeps source-aware browser history on wide layouts", () => {
    const browser = stubWindow({ returnTo: "/favorites" });

    navigateToWorkspaceUp({
      mobile: false,
      fallbackLocation: "/voices",
      isWorkspaceListLocation: () => false,
    });

    expect(browser.back).toHaveBeenCalledOnce();
    expect(browser.replaceState).not.toHaveBeenCalled();
  });
});

function stubWindow(state: Record<string, unknown>) {
  const back = vi.fn();
  const pushState = vi.fn();
  const replaceState = vi.fn();
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", {
    history: { state, back, pushState, replaceState },
    location: { pathname: "/RJ00000000", search: "", hash: "" },
    scrollY: 0,
    dispatchEvent,
  });
  return { back, pushState, replaceState, dispatchEvent };
}

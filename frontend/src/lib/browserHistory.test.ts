import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NAVIGATION_EVENT,
  browserPushHistoryState,
  enableInAppBackStack,
  historyBackStack,
  historyStateWithBackStack,
  historyStateWithReturn,
  inAppPushHistoryState,
  navigateInAppBack,
  navigateToHistoryReturn,
  navigateToWorkspaceUp,
  workspaceSwitchHistoryState,
} from "./browserHistory";

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

describe("in-app back stack", () => {
  beforeEach(() => {
    enableInAppBackStack(true);
    vi.stubGlobal(
      "PopStateEvent",
      class extends Event {
        constructor(type: string) {
          super(type);
        }
      },
    );
  });
  afterEach(() => {
    enableInAppBackStack(false);
    vi.unstubAllGlobals();
  });

  const listEntry = { location: "/?q=example", state: { libraryBrowse: true }, scrollY: 320 };
  const circleEntry = { location: "/circles/example", state: { circle: true }, scrollY: 40 };

  it("stacks the entry a push leaves, without the stack its copied state carries", () => {
    stubWindow({ detail: true, __kikotoScrollY: 120, __kikotoBackStack: [listEntry] });

    const state = inAppPushHistoryState({ copied: true, __kikotoBackStack: [listEntry] }, { replacesList: false });

    expect(historyBackStack(state)).toEqual([
      listEntry,
      { location: "/RJ00000000", state: { detail: true, __kikotoScrollY: 120 }, scrollY: 120 },
    ]);
    expect(state.copied).toBe(true);
  });

  it("keeps the current stack when a push only replaces the workspace list", () => {
    stubWindow({ __kikotoBackStack: [circleEntry] });

    expect(historyBackStack(inAppPushHistoryState({}, { replacesList: true }))).toEqual([circleEntry]);
  });

  it("gives a destination switch its own stack instead of the one it leaves", () => {
    stubWindow({ __kikotoBackStack: [circleEntry] });

    const resumed = inAppPushHistoryState(
      workspaceSwitchHistoryState({ favorites: true, __kikotoBackStack: [listEntry] }),
      { replacesList: false },
    );
    const opened = inAppPushHistoryState(workspaceSwitchHistoryState({}), { replacesList: false });

    expect(historyBackStack(resumed)).toEqual([listEntry]);
    expect(resumed).not.toHaveProperty("__kikotoWorkspaceSwitch");
    expect(historyBackStack(opened)).toEqual([]);
    expect(browserPushHistoryState(workspaceSwitchHistoryState({ a: 1 }))).toEqual({ a: 1 });
  });

  it("keeps only the newest thirty entries", () => {
    const stack = Array.from({ length: 35 }, (_, index) => ({ location: `/?page=${index}`, state: {}, scrollY: 0 }));

    const bounded = historyBackStack(historyStateWithBackStack({}, stack));

    expect(bounded).toHaveLength(30);
    expect(bounded[0].location).toBe("/?page=5");
  });

  it("returns to the stacked entry with its scroll and the stack below it", () => {
    const browser = stubWindow({ __kikotoBackStack: [circleEntry, listEntry] });

    expect(navigateInAppBack()).toBe(true);

    expect(browser.replaceState).toHaveBeenCalledWith(
      { libraryBrowse: true, __kikotoScrollY: 320, __kikotoBackStack: [circleEntry] },
      "",
      "/?q=example",
    );
    expect(browser.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "popstate" }));
    expect(browser.back).not.toHaveBeenCalled();
  });

  it("reports an empty stack without navigating", () => {
    const browser = stubWindow({ __kikotoBackStack: [] });

    expect(navigateInAppBack()).toBe(false);
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(browser.dispatchEvent).not.toHaveBeenCalled();
  });

  it("replaces a detail with its declared return when nothing is stacked", () => {
    const browser = stubWindow({ returnTo: "/favorites", __kikotoMobileTabResume: true });

    navigateToHistoryReturn({ fallbackLocation: "/" });

    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.back).not.toHaveBeenCalled();
    expect(browser.replaceState).toHaveBeenCalledWith({ __kikotoBackStack: [] }, "", "/favorites");
  });

  it("pops workspace Up to the nearest list entry of the workspace", () => {
    const voiceList = { location: "/voices?q=example", state: {}, scrollY: 80 };
    const voiceDetail = { location: "/voices/example", state: {}, scrollY: 0 };
    const browser = stubWindow({ __kikotoBackStack: [listEntry, voiceList, voiceDetail] });

    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: "/voices",
      isWorkspaceListLocation: (location) => location.startsWith("/voices") && !location.startsWith("/voices/"),
    });

    expect(browser.replaceState).toHaveBeenCalledWith(
      { __kikotoScrollY: 80, __kikotoBackStack: [listEntry] },
      "",
      "/voices?q=example",
    );
  });

  it("replaces workspace Up with the list and clears a stack that holds none", () => {
    const browser = stubWindow({ __kikotoBackStack: [listEntry] });

    navigateToWorkspaceUp({
      mobile: true,
      fallbackLocation: "/voices",
      isWorkspaceListLocation: (location) => location.startsWith("/voices") && !location.startsWith("/voices/"),
    });

    expect(browser.replaceState).toHaveBeenCalledWith({ __kikotoBackStack: [] }, "", "/voices");
  });

  it("never nests a back stack in a captured return entry", () => {
    stubWindow({ list: true, __kikotoBackStack: [listEntry] });

    const state = historyStateWithReturn("/", "Library");

    expect(state.__kikotoReturnEntry).toEqual({ location: "/RJ00000000", state: { list: true }, scrollY: 0 });
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

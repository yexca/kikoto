import { navItems, type PageID } from "./navigation";
import {
  historyStateWithWorkDetailOwner,
  workDetailCodeFromLocation,
  workDetailOwnerPage,
} from "./workDetailNavigation";
import { isVoiceDetailPath } from "../lib/voiceRoute";
import { isWorkCodePath } from "../lib/workCode";

export type AppPage = PageID | "not-found";

/** The page that renders a path. A work route resolves to Library, its default owner. */
export function pageFromPath(rawPath: string): AppPage {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  if (path === "/" || isWorkCodePath(path)) {
    return "library";
  }
  const item = navItems.find((navItem) => navItem.path === path);
  if (item) {
    return item.id;
  }
  if (/^\/[^/]+$/.test(path)) {
    return "library";
  }
  if (/^\/circles\/[^/]+(?:\/series(?:\/[^/]+)?)?$/.test(path)) {
    return "circles";
  }
  if (path === "/voices" || isVoiceDetailPath(path)) {
    return "voice-actors";
  }
  if (
    path === "/tracked" ||
    path === "/no-source" ||
    ["/library", "/library/tracked", "/library/no-source", "/library/all", "/library/remote"].includes(path) ||
    /^\/library\/source\/[^/]+$/.test(path)
  ) {
    return "library";
  }
  return "not-found";
}

/**
 * The page a history entry belongs to. Work detail is not a Library route: its
 * entry belongs to the page it was opened from, recorded in the entry's state.
 */
export function appPageForLocation(location: string, state: unknown): AppPage {
  try {
    const parsed = new URL(location, "https://kikoto.invalid");
    if (workDetailCodeFromLocation(parsed.pathname, parsed.search) !== null) return workDetailOwnerPage(state);
    return pageFromPath(parsed.pathname);
  } catch {
    return "not-found";
  }
}

export function currentAppPage(): AppPage {
  return appPageForLocation(`${window.location.pathname}${window.location.search}`, window.history.state);
}

export function isWorkDetailLocationOpen() {
  return workDetailCodeFromLocation(window.location.pathname, window.location.search) !== null;
}

/**
 * Records the owning page on a history entry that is about to show work
 * detail: the page the navigation starts from, unless the entry already names
 * one. Other entries pass through unchanged.
 */
export function historyStateForNavigation(state: unknown, url: string | URL | null | undefined): unknown {
  if (!opensWorkDetail(url)) return state;
  const current = currentAppPage();
  return historyStateWithWorkDetailOwner(state, current === "not-found" ? "library" : current);
}

function opensWorkDetail(url: string | URL | null | undefined) {
  try {
    const target = url == null ? new URL(window.location.href) : new URL(String(url), window.location.href);
    return workDetailCodeFromLocation(target.pathname, target.search) !== null;
  } catch {
    return false;
  }
}

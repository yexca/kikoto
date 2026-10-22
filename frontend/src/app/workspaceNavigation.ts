import { appPageForLocation, currentAppPage, pageFromPath } from "@/app/appRoutes";
import { navItems, type PageID } from "@/app/navigation";
import { currentInternalLocation, navigateToWorkspaceUp } from "@/lib/browserHistory";
import { isCircleListLocation, readLastCircleListLocation } from "@/lib/circleNavigationState";
import { normalizeLibraryBrowseLocation, readLastLibraryLocation } from "@/lib/libraryBrowseState";
import { isVoiceListLocation, readLastVoiceListLocation } from "@/lib/voiceNavigationState";
import { isVoiceDetailPath } from "@/lib/voiceRoute";

/** The bottom-navigation workspaces whose list controls live in their location. */
const browseWorkspaces: readonly PageID[] = ["library", "favorites", "circles", "voice-actors"];

export function isMobileTabDetailLocation(id: PageID, location: string) {
  try {
    const parsed = new URL(location, "https://kikoto.invalid");
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname;
    const listLocation = `${pathname}${parsed.search}`;
    if (id === "library") {
      return pageFromPath(pathname) === "library" && normalizeLibraryBrowseLocation(listLocation) === null;
    }
    if (id === "circles") return /^\/circles\/[^/]+(?:\/series(?:\/[^/]+)?)?$/i.test(pathname);
    if (id === "voice-actors") return isVoiceDetailPath(pathname);
  } catch {
    return false;
  }
  return false;
}

/** Whether a location is the page's own list or landing view rather than a detail. */
function isWorkspaceListLocation(id: PageID, location: string) {
  if (id === "library") return normalizeLibraryBrowseLocation(location) !== null;
  if (id === "circles") return isCircleListLocation(location);
  if (id === "voice-actors") return isVoiceListLocation(location);
  return pageFromPath(new URL(location, "https://kikoto.invalid").pathname) === id;
}

/** Where a page's own list or landing view is: the last list state it recorded, or its root. */
export function pageHomeLocation(id: PageID, storageScope: string) {
  if (id === "library") return readLastLibraryLocation(storageScope) ?? "/";
  if (id === "circles") return readLastCircleListLocation(storageScope) ?? "/circles";
  if (id === "voice-actors") return readLastVoiceListLocation(storageScope) ?? "/voices";
  return navItems.find((item) => item.id === id)?.path ?? "/";
}

export function navigateToMobileTabHome(id: PageID, storageScope: string) {
  navigateToWorkspaceUp({
    mobile: true,
    fallbackLocation: pageHomeLocation(id, storageScope),
    isWorkspaceListLocation: (location) => isWorkspaceListLocation(id, location),
  });
}

/**
 * Whether a navigation only changes the list a browse workspace shows: a tab,
 * scope, filter, or page of the same list. With an in-app back stack such a
 * change replaces the list entry instead of becoming a Back step.
 */
export function replacesWorkspaceList(url: string | URL | null | undefined, state: unknown) {
  const page = currentAppPage();
  if (page === "not-found" || !browseWorkspaces.includes(page)) return false;
  const target = navigationTarget(url);
  if (target === null) return false;
  return (
    appPageForLocation(target, state) === page &&
    isWorkspaceListLocation(page, currentInternalLocation()) &&
    isWorkspaceListLocation(page, target)
  );
}

/**
 * Whether a navigation opens a page of another browse workspace than the
 * current one, as a circle link from a Library work does. With an in-app back
 * stack such a page starts its workspace without the entries of the one it
 * leaves. Other pages keep stacking the entry they leave.
 */
export function changesWorkspace(url: string | URL | null | undefined, state: unknown) {
  const page = currentAppPage();
  if (page === "not-found" || !browseWorkspaces.includes(page)) return false;
  const target = navigationTarget(url);
  if (target === null) return false;
  const targetPage = appPageForLocation(target, state);
  return targetPage !== "not-found" && targetPage !== page && browseWorkspaces.includes(targetPage);
}

function navigationTarget(url: string | URL | null | undefined) {
  try {
    const parsed = new URL(url == null ? window.location.href : String(url), window.location.href);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

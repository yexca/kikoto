import { currentAppPage } from "./appRoutes";
import { readMobileTabSnapshot } from "./mobileTabState";
import { navItems, type PageID } from "./navigation";
import { historyStateWithWorkDetailOwner, workDetailCodeFromLocation, workDetailRoute } from "./workDetailNavigation";
import {
  NAVIGATION_EVENT,
  currentInternalLocation,
  historyStateWithReturn,
  mobileTabResumeHistoryState,
  normalizeInternalLocation,
  requestHistoryScrollRestoration,
  workspaceSwitchHistoryState,
} from "../lib/browserHistory";

/** Where a track was queued from, recorded so the player can lead back to it. */
export type PlaybackOrigin = {
  /** The app page that was showing. */
  originPage?: string;
  /** The work detail location, when the track was queued from one. */
  originWorkLocation?: string;
};

export function currentPlaybackOrigin(): PlaybackOrigin {
  const page = currentAppPage();
  if (page === "not-found") return {};
  const location = `${window.location.pathname}${window.location.search}`;
  return workCodeAt(location) === null ? { originPage: page } : { originPage: page, originWorkLocation: location };
}

/**
 * Opens the detail of the work that is playing. On the bottom-navigation
 * layout the work belongs to the destination its playback started from: that
 * destination resumes its own entry when it still shows the work, and
 * otherwise opens the work as its own. Elsewhere, and for a track with no
 * recorded origin, the work opens in the current page.
 */
export function openPlayingWorkDetail({
  workCode,
  origin,
  returnToOrigin,
  storageScope,
  returnLabel,
}: {
  workCode: string;
  origin: PlaybackOrigin;
  returnToOrigin: boolean;
  storageScope: string;
  returnLabel: string;
}) {
  // A track of another edition carries that edition's code; the location it
  // was queued from names the work the listener actually opened.
  const originLocation = normalizeInternalLocation(origin.originWorkLocation ?? "");
  const route =
    originLocation && workCodeAt(originLocation) !== null
      ? originLocation
      : workDetailRoute({ kind: "known", canonicalCode: workCode });
  if (!route) return;
  const targetCode = workCodeAt(route);
  const here = currentInternalLocation();
  if (workCodeAt(here) === targetCode) return;

  const owner = returnToOrigin ? navItems.find((item) => item.id === origin.originPage)?.id : undefined;
  if (owner && owner !== currentAppPage()) {
    const snapshot = readMobileTabSnapshot(storageScope, owner);
    if (snapshot && workCodeAt(snapshot.location) === targetCode) {
      window.history.pushState(
        requestHistoryScrollRestoration(
          workspaceSwitchHistoryState(mobileTabResumeHistoryState(snapshot.state)),
          snapshot.scrollY,
        ),
        "",
        snapshot.location,
      );
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
      return;
    }
  }

  const state = historyStateWithReturn(here, returnLabel);
  window.history.pushState(ownedState(state, owner), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function ownedState(state: Record<string, unknown>, owner: PageID | undefined) {
  return owner ? historyStateWithWorkDetailOwner(state, owner, true) : state;
}

function workCodeAt(location: string) {
  try {
    const parsed = new URL(location, "https://kikoto.invalid");
    return workDetailCodeFromLocation(parsed.pathname, parsed.search)?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

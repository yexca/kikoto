import { useCallback, useEffect, useState } from "react";

import { NAVIGATION_EVENT, navigateBackOr } from "@/lib/browserHistory";

import { readRecordsLocation, type RecordsLocation, type RecordsNavigation } from "./recordsLocation";

function snapshot() {
  return { location: readRecordsLocation(window.location.search), state: window.history.state as unknown };
}

/** Applies a Record navigation to browser history and announces it like any other in-app navigation. */
export function applyRecordsNavigation(navigation: RecordsNavigation) {
  if (navigation.mode === "back") {
    navigateBackOr(() => {
      window.history.replaceState(navigation.fallback.state, "", navigation.fallback.href);
      window.dispatchEvent(new Event(NAVIGATION_EVENT));
    });
    return;
  }
  if (navigation.mode === "push") window.history.pushState(navigation.state, "", navigation.href);
  else window.history.replaceState(navigation.state, "", navigation.href);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/** The Record page location, following browser Back, Forward, and in-app navigation. */
export function useRecordsLocation(): {
  location: RecordsLocation;
  historyState: unknown;
  navigate: (build: (location: RecordsLocation, state: unknown) => RecordsNavigation) => void;
} {
  const [current, setCurrent] = useState(snapshot);

  useEffect(() => {
    const sync = () => setCurrent(snapshot());
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATION_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATION_EVENT, sync);
    };
  }, []);

  const navigate = useCallback((build: (location: RecordsLocation, state: unknown) => RecordsNavigation) => {
    const { location, state } = snapshot();
    applyRecordsNavigation(build(location, state));
  }, []);

  return { location: current.location, historyState: current.state, navigate };
}

import { useEffect, useState } from "react";

import { useLatestLoad } from "@/hooks/useLatestLoad";
import { api } from "@/lib/api";

import { RELEASE_FEED_SEEN_EVENT } from "./subscriptionModel";

const refreshIntervalMs = 5 * 60 * 1000;

/**
 * The number of feed entries added since the account last opened
 * Discover's New releases, for the navigation badge. It refreshes when the window
 * returns and every few minutes while visible.
 */
export function useReleaseFeedUnread(enabled: boolean) {
  const [count, setCount] = useState(0);
  // Each read replaces the one before it.
  const latest = useLatestLoad();

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    const load = () =>
      void latest.run((signal) => api.getReleaseFeedUnread(signal), { onSuccess: (result) => setCount(result.count) });
    const loadWhenVisible = () => {
      if (!document.hidden) load();
    };
    const clear = () => setCount(0);
    load();
    const timer = window.setInterval(loadWhenVisible, refreshIntervalMs);
    document.addEventListener("visibilitychange", loadWhenVisible);
    window.addEventListener(RELEASE_FEED_SEEN_EVENT, clear);
    return () => {
      latest.cancel();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadWhenVisible);
      window.removeEventListener(RELEASE_FEED_SEEN_EVENT, clear);
    };
  }, [enabled, latest]);

  return count;
}

import { useLayoutEffect } from "react";

import { historyStateForNavigation } from "@/app/appRoutes";
import { replacesWorkspaceList } from "@/app/workspaceNavigation";
import {
  HISTORY_ENTRY_UPDATED_EVENT,
  NAVIGATION_EVENT,
  SCROLL_RESTORATION_EVENT,
  browserPushHistoryState,
  historyEntryKey,
  historyPushStateWithScroll,
  historyScrollY,
  historyStateKeepingBackStack,
  historyStateWithEntryKey,
  historyStateWithScroll,
  inAppPushHistoryState,
  setHistoryEntryWriter,
  usesInAppBackStack,
} from "@/lib/browserHistory";

export function useScrollRestoration() {
  useLayoutEffect(() => {
    const history = window.history;
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    const announceEntryUpdate = () => window.dispatchEvent(new Event(HISTORY_ENTRY_UPDATED_EVENT));
    const newEntryKey = () =>
      window.crypto.randomUUID?.() ?? Array.from(window.crypto.getRandomValues(new Uint32Array(2))).join("-");
    const ensureEntryKey = (): string => {
      const existing = historyEntryKey(history.state);
      if (existing) return existing;
      const key = newEntryKey();
      originalReplaceState(historyStateWithEntryKey(history.state, key), "");
      return key;
    };
    ensureEntryKey();

    let restoring: { key: string; scrollY: number } | null = null;
    let restoreFrame: number | null = null;
    let restoreTimeout: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let pendingWrite: number | null = null;
    const cancelWrite = () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      pendingWrite = null;
    };
    const cancelRestore = () => {
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      if (restoreTimeout !== null) window.clearTimeout(restoreTimeout);
      resizeObserver?.disconnect();
      restoreFrame = null;
      restoreTimeout = null;
      resizeObserver = null;
      restoring = null;
    };
    const rememberCurrentEntry = () => {
      const scrollY = restoring?.key === historyEntryKey(history.state) ? restoring.scrollY : window.scrollY;
      originalReplaceState(historyStateWithScroll(history.state, scrollY), "");
      announceEntryUpdate();
    };
    const restore = (beforePaint = false) => {
      cancelWrite();
      cancelRestore();
      const target = { key: ensureEntryKey(), scrollY: historyScrollY(history.state) };
      restoring = target;
      const apply = () => {
        if (restoring !== target || historyEntryKey(history.state) !== target.key) return;
        const scrollingElement = document.scrollingElement ?? document.documentElement;
        const maxScrollY = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
        window.scrollTo({ top: target.scrollY, behavior: "auto" });
        if (maxScrollY + 1 >= target.scrollY) cancelRestore();
      };
      const schedule = () => {
        if (restoring !== target || restoreFrame !== null) return;
        restoreFrame = window.requestAnimationFrame(() => {
          restoreFrame = null;
          apply();
        });
      };
      // Content height can arrive later than a fixed retry window. The next
      // navigation or user input cancels this entry's pending restoration.
      resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(document.body);
      restoreTimeout = window.setTimeout(() => {
        apply();
        cancelRestore();
      }, 10_000);
      if (beforePaint) apply();
      else schedule();
    };

    history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
      cancelWrite();
      rememberCurrentEntry();
      cancelRestore();
      const entryState = historyStateForNavigation(historyPushStateWithScroll(state), url);
      if (usesInAppBackStack()) {
        // A push replaces the single entry and stacks the one it leaves.
        const nextState = inAppPushHistoryState(entryState, { replacesList: replacesWorkspaceList(url, entryState) });
        originalReplaceState(historyStateWithEntryKey(nextState, newEntryKey()), unused, url);
        return;
      }
      originalPushState(historyStateWithEntryKey(browserPushHistoryState(entryState), newEntryKey()), unused, url);
    }) as History["pushState"];
    history.replaceState = ((state: unknown, unused: string, url?: string | URL | null) => {
      const key = ensureEntryKey();
      const entryState = usesInAppBackStack() ? historyStateKeepingBackStack(state, history.state) : state;
      originalReplaceState(historyStateWithEntryKey(historyStateForNavigation(entryState, url), key), unused, url);
      announceEntryUpdate();
    }) as History["replaceState"];
    setHistoryEntryWriter((state, location) => {
      cancelWrite();
      cancelRestore();
      originalReplaceState(
        historyEntryKey(state) ? state : historyStateWithEntryKey(state, newEntryKey()),
        "",
        location,
      );
      announceEntryUpdate();
    });

    const handleNavigation = () => restore();
    const handleReady = () => restore(true);
    const handleUserScrollIntent = () => {
      cancelRestore();
      cancelWrite();
      rememberCurrentEntry();
    };
    let observedScrollY = window.scrollY;
    const handleScroll = () => {
      if (restoring) return;
      observedScrollY = window.scrollY;
      if (pendingWrite !== null) return;
      const key = historyEntryKey(history.state);
      pendingWrite = window.setTimeout(() => {
        pendingWrite = null;
        if (key !== historyEntryKey(history.state) || restoring) return;
        originalReplaceState(historyStateWithScroll(history.state, observedScrollY), "");
        announceEntryUpdate();
      }, 150);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") rememberCurrentEntry();
    };
    window.addEventListener(NAVIGATION_EVENT, handleNavigation);
    window.addEventListener("popstate", handleNavigation);
    window.addEventListener(SCROLL_RESTORATION_EVENT, handleReady);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("wheel", handleUserScrollIntent, { passive: true });
    window.addEventListener("touchstart", handleUserScrollIntent, { passive: true });
    window.addEventListener("pointerdown", handleUserScrollIntent, { passive: true });
    window.addEventListener("keydown", handleUserScrollIntent);
    window.addEventListener("pagehide", rememberCurrentEntry);
    document.addEventListener("visibilitychange", handleVisibility);
    restore();
    return () => {
      cancelWrite();
      rememberCurrentEntry();
      cancelRestore();
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      setHistoryEntryWriter(null);
      history.scrollRestoration = previousRestoration;
      window.removeEventListener(NAVIGATION_EVENT, handleNavigation);
      window.removeEventListener("popstate", handleNavigation);
      window.removeEventListener(SCROLL_RESTORATION_EVENT, handleReady);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("wheel", handleUserScrollIntent);
      window.removeEventListener("touchstart", handleUserScrollIntent);
      window.removeEventListener("pointerdown", handleUserScrollIntent);
      window.removeEventListener("keydown", handleUserScrollIntent);
      window.removeEventListener("pagehide", rememberCurrentEntry);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}

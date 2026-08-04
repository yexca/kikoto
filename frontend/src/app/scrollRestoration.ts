import { useEffect } from "react";

import {
  HISTORY_ENTRY_UPDATED_EVENT,
  NAVIGATION_EVENT,
  historyPushStateWithScroll,
  historyScrollY,
  historyStateWithScroll,
} from "@/lib/browserHistory";

export function useScrollRestoration() {
  useEffect(() => {
    const history = window.history;
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";

    const announceEntryUpdate = () => window.dispatchEvent(new Event(HISTORY_ENTRY_UPDATED_EVENT));
    const rememberCurrentEntry = () => {
      originalReplaceState(historyStateWithScroll(history.state, window.scrollY), "", window.location.href);
      announceEntryUpdate();
    };
    rememberCurrentEntry();

    history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
      rememberCurrentEntry();
      originalPushState(historyPushStateWithScroll(state), unused, url);
    }) as History["pushState"];

    history.replaceState = ((state: unknown, unused: string, url?: string | URL | null) => {
      originalReplaceState(state, unused, url);
      announceEntryUpdate();
    }) as History["replaceState"];

    let restoreTimers: number[] = [];
    const cancelRestore = () => {
      restoreTimers.forEach((timer) => window.clearTimeout(timer));
      restoreTimers = [];
    };
    const restore = (scrollY: number, retry: boolean) => {
      cancelRestore();
      const apply = () => window.scrollTo({ top: scrollY, behavior: "auto" });
      window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
      if (retry && scrollY > 0) {
        restoreTimers = [50, 200, 500].map((delay) => window.setTimeout(apply, delay));
      }
    };
    const handleNavigation = () => {
      const scrollY = historyScrollY(history.state);
      restore(scrollY, scrollY > 0);
    };
    const handlePopState = (event: PopStateEvent) => restore(historyScrollY(event.state), true);
    const handleUserScrollIntent = () => cancelRestore();

    let pendingWrite: number | null = null;
    const handleScroll = () => {
      if (pendingWrite !== null) return;
      pendingWrite = window.setTimeout(() => {
        pendingWrite = null;
        rememberCurrentEntry();
      }, 150);
    };
    window.addEventListener(NAVIGATION_EVENT, handleNavigation);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("wheel", handleUserScrollIntent, { passive: true });
    window.addEventListener("touchstart", handleUserScrollIntent, { passive: true });
    window.addEventListener("pointerdown", handleUserScrollIntent, { passive: true });
    window.addEventListener("keydown", handleUserScrollIntent);
    return () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      cancelRestore();
      rememberCurrentEntry();
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      history.scrollRestoration = previousRestoration;
      window.removeEventListener(NAVIGATION_EVENT, handleNavigation);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("wheel", handleUserScrollIntent);
      window.removeEventListener("touchstart", handleUserScrollIntent);
      window.removeEventListener("pointerdown", handleUserScrollIntent);
      window.removeEventListener("keydown", handleUserScrollIntent);
    };
  }, []);
}

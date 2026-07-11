import { useEffect } from "react";

const scrollStateKey = "__kikotoScrollY";

type ScrollHistoryState = Record<string, unknown> & { [scrollStateKey]?: number };

export function useScrollRestoration() {
  useEffect(() => {
    const history = window.history;
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";

    const stateWithScroll = (state: unknown, scrollY: number): ScrollHistoryState => ({
      ...(state && typeof state === "object" ? state as Record<string, unknown> : {}),
      [scrollStateKey]: Math.max(0, scrollY),
    });
    const rememberCurrentEntry = () => {
      originalReplaceState(stateWithScroll(history.state, window.scrollY), "", window.location.href);
    };
    rememberCurrentEntry();

    history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
      rememberCurrentEntry();
      originalPushState(stateWithScroll(state, 0), unused, url);
    }) as History["pushState"];

    let restoreTimers: number[] = [];
    const cancelRestore = () => {
      restoreTimers.forEach((timer) => window.clearTimeout(timer));
      restoreTimers = [];
    };
    const restore = (scrollY: number) => {
      cancelRestore();
      const apply = () => window.scrollTo({ top: scrollY, behavior: "auto" });
      window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
      restoreTimers = [50, 200, 500].map((delay) => window.setTimeout(apply, delay));
    };
    const handleNavigation = () => restore(Number((history.state as ScrollHistoryState | null)?.[scrollStateKey]) || 0);
    const handlePopState = (event: PopStateEvent) => restore(Number((event.state as ScrollHistoryState | null)?.[scrollStateKey]) || 0);

    let pendingWrite: number | null = null;
    const handleScroll = () => {
      if (pendingWrite !== null) return;
      pendingWrite = window.setTimeout(() => {
        pendingWrite = null;
        rememberCurrentEntry();
      }, 150);
    };
    window.addEventListener("kikoto:navigation", handleNavigation);
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      cancelRestore();
      rememberCurrentEntry();
      history.pushState = originalPushState;
      history.scrollRestoration = previousRestoration;
      window.removeEventListener("kikoto:navigation", handleNavigation);
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("scroll", handleScroll);
    };
  }, []);
}

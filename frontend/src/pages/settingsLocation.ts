import { useEffect, useState } from "react";

import { NAVIGATION_EVENT } from "@/lib/browserHistory";

/** The tab a settings page shows and, for a link into one, the section of it to land on. */
export type SettingsLocation<Tab extends string> = { tab: Tab; section?: string };

/** Every tab shares one content width so switching tabs never shifts the layout. */
export const settingsPanelClassName = "w-full max-w-4xl space-y-10";

function currentTabParameter() {
  return new URLSearchParams(window.location.search).get("tab") ?? "";
}

/**
 * Keeps a settings page's open tab in the `tab` query parameter of its path.
 * The default tab has no parameter. `resolve` maps a parameter, including an
 * alias, to a tab and must not change between renders. A location that names a
 * section scrolls to the element with the id `settings-section-<section>`.
 */
export function useSettingsLocation<Tab extends string>(
  path: string,
  defaultTab: Tab,
  resolve: (tab: string) => SettingsLocation<Tab>,
) {
  // Each navigation stores a fresh object, so opening the same section again scrolls again.
  const [location, setLocation] = useState(() => resolve(currentTabParameter()));

  useEffect(() => {
    const syncFromLocation = () => {
      if (window.location.pathname !== path) return;
      setLocation(resolve(currentTabParameter()));
    };
    window.addEventListener(NAVIGATION_EVENT, syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener(NAVIGATION_EVENT, syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, [path, resolve]);

  useEffect(() => {
    const section = location.section;
    if (!section) return;
    // Navigation scroll restoration places a new entry at the top two frames later, and the
    // section content loads lazily; land on the section after both.
    let observer: ResizeObserver | undefined;
    const scrollWhenRendered = () => {
      const element = document.getElementById(`settings-section-${section}`);
      if (!element) return;
      observer = new ResizeObserver(() => {
        if (element.offsetHeight === 0) return;
        observer?.disconnect();
        element.scrollIntoView();
      });
      observer.observe(element);
    };
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(scrollWhenRendered);
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [location]);

  const select = (tab: Tab) => {
    setLocation({ tab });
    const url = new URL(window.location.href);
    if (tab === defaultTab) url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };

  return { tab: location.tab, select };
}

import { useEffect, useRef } from "react";

// Keep the finished preload briefly so the player element can adopt its buffered
// data after it switches to the same URL.
const PRELOAD_RELEASE_DELAY_MS = 8_000;

/**
 * Warms one upcoming track in a detached audio element. The player element later
 * requests the identical URL, so the browser media cache can reuse the buffered
 * bytes and a prepared server-side conversion is already available.
 */
export function useNextTrackPreload(url: string | null) {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const releaseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    if (url) {
      if (typeof Audio === "undefined" || prefersReducedData()) return;
      let element = elementRef.current;
      if (!element) {
        element = new Audio();
        element.preload = "auto";
        element.muted = true;
        elementRef.current = element;
      }
      if (element.getAttribute("src") === url) return;
      element.src = url;
      element.load();
      return;
    }
    const element = elementRef.current;
    if (!element?.getAttribute("src")) return;
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      releaseElement(element);
    }, PRELOAD_RELEASE_DELAY_MS);
  }, [url]);

  useEffect(
    () => () => {
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      if (elementRef.current) releaseElement(elementRef.current);
      elementRef.current = null;
    },
    [],
  );
}

function prefersReducedData() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function releaseElement(element: HTMLAudioElement) {
  element.removeAttribute("src");
  try {
    element.load();
  } catch {
    // Releasing a detached element is best-effort.
  }
}

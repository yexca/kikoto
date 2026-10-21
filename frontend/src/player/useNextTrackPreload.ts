import { useEffect, useRef } from "react";

import { warmAudioHls } from "./audioHlsSource";
import type { PlayerAudioSource } from "./playerTrackMedia";

// Keep the finished preload briefly so the player element can adopt its buffered
// data after it switches to the same URL.
const PRELOAD_RELEASE_DELAY_MS = 8_000;

/**
 * Warms one upcoming track. A file the browser plays itself, or a complete
 * conversion, loads in a detached audio element; the player element later
 * requests the identical URL, so the browser media cache can reuse the
 * buffered bytes and a prepared server-side conversion is already available.
 * An HLS playlist only has its first segment requested, which starts the
 * server's conversion of the track.
 */
export function useNextTrackPreload(source: PlayerAudioSource | null) {
  const elementRef = useRef<HTMLAudioElement | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const url = source?.url ?? null;
  const delivery = source?.delivery ?? null;

  useEffect(() => {
    if (!url || delivery !== "hls" || prefersReducedData()) return;
    const controller = new AbortController();
    void warmAudioHls(url, controller.signal).catch(() => {
      // Warming is best-effort; the player requests the playlist itself.
    });
    return () => controller.abort();
  }, [delivery, url]);

  const elementURL = delivery === "hls" ? null : url;
  useEffect(() => {
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    if (elementURL) {
      if (typeof Audio === "undefined" || prefersReducedData()) return;
      let element = elementRef.current;
      if (!element) {
        element = new Audio();
        element.preload = "auto";
        element.muted = true;
        elementRef.current = element;
      }
      if (element.getAttribute("src") === elementURL) return;
      element.src = elementURL;
      element.load();
      return;
    }
    const element = elementRef.current;
    if (!element?.getAttribute("src")) return;
    releaseTimerRef.current = window.setTimeout(() => {
      releaseTimerRef.current = null;
      releaseElement(element);
    }, PRELOAD_RELEASE_DELAY_MS);
  }, [elementURL]);

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

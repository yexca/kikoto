// A deploy replaces the content-hashed chunks under /assets/, so a page opened
// before it requests chunks that no longer exist. Importing the same URL again
// fails the same way; only a reload, which fetches the new app shell and its
// chunk names, recovers.

const reportedPreloadErrors = new WeakSet<object>();

// Browser wording for a dynamic import whose module could not be fetched
// (Chromium, Firefox, Safari), plus Vite's CSS preload failure.
const chunkLoadMessages = [
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Unable to preload CSS/i,
];

/** Records the errors Vite reports for failed chunk loads so they can be recognized later. */
export function trackChunkLoadErrors(target: EventTarget = window) {
  const record = (event: Event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (payload && typeof payload === "object") reportedPreloadErrors.add(payload);
  };
  target.addEventListener("vite:preloadError", record);
  return () => target.removeEventListener("vite:preloadError", record);
}

export function isChunkLoadError(error: unknown) {
  if (error && typeof error === "object" && reportedPreloadErrors.has(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return chunkLoadMessages.some((pattern) => pattern.test(message));
}

export function reloadApp() {
  window.location.reload();
}

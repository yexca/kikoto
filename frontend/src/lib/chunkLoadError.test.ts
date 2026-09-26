import { describe, expect, it } from "vitest";

import { isChunkLoadError, trackChunkLoadErrors } from "@/lib/chunkLoadError";

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://kikoto.example.test/assets/AboutPage-1a2b3c.js",
    "error loading dynamically imported module: https://kikoto.example.test/assets/AboutPage-1a2b3c.js",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/AboutPage-1a2b3c.css",
  ])("recognizes a browser chunk failure: %s", (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it("does not treat a page's own render error as a stale version", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it("recognizes an error Vite reported for a failed preload whatever its wording", () => {
    const target = new EventTarget();
    const stop = trackChunkLoadErrors(target);
    const error = new Error("Load failed");
    expect(isChunkLoadError(error)).toBe(false);

    target.dispatchEvent(Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload: error }));

    expect(isChunkLoadError(error)).toBe(true);
    stop();
  });
});

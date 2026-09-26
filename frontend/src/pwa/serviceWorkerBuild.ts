import { createHash } from "node:crypto";

// Build-time helpers for public/sw.js. They run in the Vite config, never in
// the app bundle.

export const SERVICE_WORKER_BUILD_PLACEHOLDER = "__KIKOTO_SERVICE_WORKER_BUILD__";

/**
 * Identifies a production build by its version and emitted file names. Hashed
 * asset names change with their content, so every build that ships different
 * assets gets a new service worker cache and the previous one is dropped on
 * activation instead of accumulating stale assets.
 */
export function serviceWorkerBuildId(appVersion: string, bundleFileNames: Iterable<string>) {
  const hash = createHash("sha256");
  for (const fileName of [...bundleFileNames].sort()) hash.update(`${fileName}\n`);
  return `${appVersion}-${hash.digest("hex").slice(0, 12)}`;
}

export function stampServiceWorker(source: string, buildId: string) {
  const parts = source.split(SERVICE_WORKER_BUILD_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error(`sw.js must contain ${SERVICE_WORKER_BUILD_PLACEHOLDER} exactly once`);
  }
  return parts.join(buildId);
}

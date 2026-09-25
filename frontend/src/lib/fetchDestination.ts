import { ApiError } from "@/lib/api";

/**
 * Codes the server returns when Fetch cannot write into the library yet: the
 * library is not set up, no Fetch storage pool is chosen, or the pool or data
 * folder is offline. Each is fixed in Settings -> Library.
 */
export const fetchDestinationCodes = [
  "library_not_configured",
  "fetch_pool_required",
  "fetch_pool_offline",
  "library_offline",
] as const;

export type FetchDestinationCode = (typeof fetchDestinationCodes)[number];

export const librarySettingsPath = "/settings?tab=library";

export function fetchDestinationCode(error: unknown): FetchDestinationCode | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  return (fetchDestinationCodes as readonly string[]).includes(error.code)
    ? (error.code as FetchDestinationCode)
    : null;
}

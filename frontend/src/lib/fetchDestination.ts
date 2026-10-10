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

/**
 * How a Fetch submission ended when the server did not accept it.
 *
 * - `sign_in`: the session expired.
 * - `plan_changed`: the reviewed plan no longer applies and must be planned again.
 * - `rejected`: the server answered and refused, so no Fetch was started.
 * - `unconfirmed`: no usable answer arrived, so a Fetch may or may not have started.
 */
export type FetchSubmissionFailure = "sign_in" | "plan_changed" | "rejected" | "unconfirmed";

export function fetchSubmissionFailure(error: unknown): FetchSubmissionFailure {
  if (!(error instanceof ApiError)) return "unconfirmed";
  if (error.status === 401) return "sign_in";
  if (error.status === 409 && (error.code === "conflict" || error.code === "")) return "plan_changed";
  if (error.status >= 400 && error.status < 500) return "rejected";
  return "unconfirmed";
}

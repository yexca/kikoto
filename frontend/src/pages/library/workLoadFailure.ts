import { ApiError } from "@/lib/api";

/**
 * How a work detail load ended when it produced no work.
 *
 * `not_found` is a definite answer: the server knows no such work, or rejects
 * the address as something that cannot name one. `failed` covers everything
 * else, where the work may well exist and trying again can succeed.
 */
export type WorkLoadFailure = "not_found" | "failed";

export function workLoadFailure(error: unknown): WorkLoadFailure {
  if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return "not_found";
  return "failed";
}

/** The API codes a media request answers with while the disk holding its file is not mounted. */
export type PlaybackStorageOfflineCode = "library_offline" | "storage_pool_offline";

/** The offline code of a media error response body, or null when it reports anything else. */
export function playbackStorageOfflineCode(status: number, body: unknown): PlaybackStorageOfflineCode | null {
  if (status !== 409 || !body || typeof body !== "object" || !("code" in body)) return null;
  return body.code === "library_offline" || body.code === "storage_pool_offline" ? body.code : null;
}

/**
 * Asks a media URL that answered a HEAD probe with 409 why. A HEAD answer has
 * no body to carry the error code, so this repeats the request as a GET for a
 * single byte: an offline disk answers with the small JSON error, and a file
 * that came back in the meantime sends one byte instead of the whole stream.
 */
export async function probePlaybackStorageOffline(
  url: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<PlaybackStorageOfflineCode | null> {
  const response = await request(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json", Range: "bytes=0-0" },
    signal,
  });
  if (response.status !== 409 || !response.headers.get("Content-Type")?.includes("json")) return null;
  const body: unknown = await response.json().catch(() => null);
  return playbackStorageOfflineCode(response.status, body);
}

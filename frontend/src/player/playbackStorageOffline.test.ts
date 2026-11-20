import { describe, expect, it, vi } from "vitest";

import { playbackStorageOfflineCode, probePlaybackStorageOffline } from "./playbackStorageOffline";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("playbackStorageOfflineCode", () => {
  it("recognizes only the offline library and storage pool conflicts", () => {
    expect(playbackStorageOfflineCode(409, { code: "library_offline" })).toBe("library_offline");
    expect(playbackStorageOfflineCode(409, { code: "storage_pool_offline" })).toBe("storage_pool_offline");
    expect(playbackStorageOfflineCode(409, { code: "database_busy" })).toBeNull();
    expect(playbackStorageOfflineCode(404, { code: "library_offline" })).toBeNull();
    expect(playbackStorageOfflineCode(409, null)).toBeNull();
  });
});

describe("probePlaybackStorageOffline", () => {
  it("reads the code a HEAD answer cannot carry with a one-byte GET", async () => {
    const request = vi.fn(async () => jsonResponse(409, { code: "storage_pool_offline", error: "offline" }));
    await expect(
      probePlaybackStorageOffline("/api/media/1/stream", new AbortController().signal, request),
    ).resolves.toBe("storage_pool_offline");
    expect(request).toHaveBeenCalledWith(
      "/api/media/1/stream",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Range: "bytes=0-0" }) }),
    );
  });

  it("reports nothing when the file is readable again or the conflict is another one", async () => {
    const signal = new AbortController().signal;
    const readable = vi.fn(async () => new Response("a", { status: 206, headers: { "Content-Type": "audio/mpeg" } }));
    await expect(probePlaybackStorageOffline("/api/media/1/stream", signal, readable)).resolves.toBeNull();
    const other = vi.fn(async () => jsonResponse(409, { code: "conflict" }));
    await expect(probePlaybackStorageOffline("/api/media/1/stream", signal, other)).resolves.toBeNull();
  });
});

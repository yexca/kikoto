import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import type { PlaybackQueueResolution, PlaybackQueueResolveItem, PlaybackQueueTrack } from "@/lib/api";
import type { ResolvePlaybackQueue } from "./playerQueueRestore";
import type { PlayerTrack } from "./playerTypes";
import { createQueueDisplayNameLoader } from "./useQueueDisplayNameRefresh";

function deferred() {
  let resolve!: (resolution: PlaybackQueueResolution) => void;
  const promise = new Promise<PlaybackQueueResolution>((done) => (resolve = done));
  return { promise, resolve };
}

const queued = (workId: number) => ({ workId, mediaItemId: workId * 10, locationId: workId * 100 }) as PlayerTrack;

function named(items: PlaybackQueueResolveItem[], displayTitle: string): PlaybackQueueResolution {
  return {
    items: items.map((item) => ({
      ...item,
      status: "playable",
      track: { mediaItemId: item.mediaItemId, displayTitle } as PlaybackQueueTrack,
    })),
    works: [],
  };
}

describe("queue display name loader", () => {
  it("resolves names in one titles-only request and keeps a newer load's names", async () => {
    const pending: Array<{ items: PlaybackQueueResolveItem[]; request: ReturnType<typeof deferred> }> = [];
    const resolve = vi.fn<ResolvePlaybackQueue>((items) => {
      const request = deferred();
      pending.push({ items, request });
      return request.promise;
    });
    const applied: string[][] = [];
    const load = createQueueDisplayNameLoader(resolve, (titles) =>
      applied.push([...titles].map(([key, title]) => `${key}=${title}`)),
    );

    // A preference change refreshes the whole queue, then a save for work 1
    // refreshes that work again and finishes first.
    const older = load([queued(1), queued(2)]);
    const newer = load([queued(1)]);
    pending[1].request.resolve(named(pending[1].items, "new"));
    await newer;
    pending[0].request.resolve(named(pending[0].items, "old"));
    await older;

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0][1]).toEqual({ titlesOnly: true });
    expect(applied).toEqual([["1:10:100=new"], ["2:20:200=old"]]);
  });

  it("keeps every name when the request fails", async () => {
    const apply = vi.fn();
    const load = createQueueDisplayNameLoader(async () => {
      throw new Error("offline");
    }, apply);

    await load([queued(1)]);

    expect(apply).not.toHaveBeenCalled();
  });
});

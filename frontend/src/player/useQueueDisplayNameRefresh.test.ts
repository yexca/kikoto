import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import type { MediaItem } from "@/lib/api";
import { createQueueDisplayNameLoader } from "./useQueueDisplayNameRefresh";

function deferred() {
  let resolve!: (items: MediaItem[]) => void;
  const promise = new Promise<MediaItem[]>((done) => (resolve = done));
  return { promise, resolve };
}

const items = (title: string) => [{ id: 1, title } as MediaItem];

describe("queue display name loader", () => {
  it("keeps a newer load's names when an older batch finishes after it", async () => {
    const pending = new Map<string, ReturnType<typeof deferred>>();
    const applied: Array<Record<number, string>> = [];
    const load = createQueueDisplayNameLoader(
      (workId) => {
        const request = deferred();
        pending.set(`${workId}:${pending.size}`, request);
        return request.promise;
      },
      (media) => applied.push(Object.fromEntries([...media].map(([workId, list]) => [workId, list[0].title]))),
    );

    // An older refresh of two works fetches work 1, then a save for work 1
    // starts a newer refresh that finishes before the older batch.
    const older = load([1, 2]);
    pending.get("1:0")!.resolve(items("old"));
    await Promise.resolve();
    const newer = load([1]);
    pending.get("1:2")!.resolve(items("new"));
    await newer;
    pending.get("2:1")!.resolve(items("second"));
    await older;

    expect(applied).toEqual([{ 1: "new" }, { 2: "second" }]);
  });

  it("leaves out a work whose media fails to load", async () => {
    const applied: number[][] = [];
    const load = createQueueDisplayNameLoader(
      async (workId) => {
        if (workId === 2) throw new Error("offline");
        return items("ok");
      },
      (media) => applied.push([...media.keys()]),
    );

    await load([1, 2]);

    expect(applied).toEqual([[1]]);
  });
});

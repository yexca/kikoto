import { describe, expect, it } from "vitest";

import type { ForYouItem, Work } from "@/lib/api";
import { syntheticWorkCode } from "@/test-support/workCode";

import type { ForYouSnapshot } from "./forYouModel";
import { clearForYouSnapshot, readForYouSnapshot, writeForYouSnapshot } from "./forYouSnapshotStore";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function snapshot(id: number): ForYouSnapshot {
  const item: ForYouItem = {
    work: { id, primaryCode: syntheticWorkCode("RJ", id) } as Work,
    score: 50,
    reason: { kind: "want" },
  };
  const column = { items: [item], coldStart: false };
  return {
    temperature: "balanced",
    algorithmVersion: "for-you-v1",
    columns: { maybe_like: column, try_new: column, listen_again: column },
  };
}

describe("For you snapshot store", () => {
  it("reads a draw written in an earlier page load of the same tab", () => {
    const storage = memoryStorage();
    writeForYouSnapshot("server:user-1", snapshot(1), storage);
    // A reload starts without memory, so the draw comes from session storage.
    clearForYouSnapshot("server:user-1", memoryStorage());
    expect(readForYouSnapshot("server:user-1", storage)?.columns.maybe_like.items[0].work.id).toBe(1);
  });

  it("keeps each account's draw apart", () => {
    const storage = memoryStorage();
    writeForYouSnapshot("server:user-2", snapshot(2), storage);
    expect(readForYouSnapshot("server:user-3", storage)).toBeNull();
  });

  it("keeps the draw in memory when session storage refuses it", () => {
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    writeForYouSnapshot("server:user-4", snapshot(4), full);
    expect(readForYouSnapshot("server:user-4", full)?.columns.try_new.items[0].work.id).toBe(4);
  });

  it("ignores a stored value it cannot read", () => {
    const storage = memoryStorage();
    storage.setItem("kikoto:for-you-draw:v1:server:user-5", "{not json");
    expect(readForYouSnapshot("server:user-5", storage)).toBeNull();
  });
});

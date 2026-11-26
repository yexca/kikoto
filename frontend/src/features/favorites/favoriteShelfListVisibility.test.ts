import { describe, expect, it } from "vitest";

import { clientStore } from "@/lib/clientStorage";

import { readFavoriteShelfListHidden, storeFavoriteShelfListHidden } from "./favoriteShelfListVisibility";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("favorite shelf list visibility", () => {
  it("shows the list until this device stores the hidden choice", () => {
    const storage = memoryStorage();
    const store = clientStore(() => storage);
    expect(readFavoriteShelfListHidden(store)).toBe(false);

    storeFavoriteShelfListHidden(true, store);
    expect(readFavoriteShelfListHidden(store)).toBe(true);

    storeFavoriteShelfListHidden(false, store);
    expect(readFavoriteShelfListHidden(store)).toBe(false);
  });

  it("shows the list when storage is unavailable or throws", () => {
    expect(readFavoriteShelfListHidden(clientStore(() => null))).toBe(false);
    const throwing = clientStore(() => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    }));
    expect(readFavoriteShelfListHidden(throwing)).toBe(false);
    expect(() => storeFavoriteShelfListHidden(true, throwing)).not.toThrow();
  });
});

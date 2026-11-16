import { describe, expect, it } from "vitest";

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
    expect(readFavoriteShelfListHidden(storage)).toBe(false);

    storeFavoriteShelfListHidden(storage, true);
    expect(readFavoriteShelfListHidden(storage)).toBe(true);

    storeFavoriteShelfListHidden(storage, false);
    expect(readFavoriteShelfListHidden(storage)).toBe(false);
  });

  it("shows the list when storage is unavailable or throws", () => {
    expect(readFavoriteShelfListHidden(undefined)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readFavoriteShelfListHidden(throwing)).toBe(false);
    expect(() => storeFavoriteShelfListHidden(throwing, true)).not.toThrow();
  });
});

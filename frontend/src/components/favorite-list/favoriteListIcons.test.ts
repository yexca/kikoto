import { describe, expect, it } from "vitest";

import { defaultFavoriteListIcon, favoriteListIcon, favoriteListIconOptions } from "./favoriteListIcons";

describe("favorite list icons", () => {
  it("offers only distinct keys the server accepts", () => {
    const keys = favoriteListIconOptions.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Mirrors the server's favorite-list icon key format.
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });

  it("falls back to the default list icon for empty or unknown keys", () => {
    expect(favoriteListIcon({ icon: "moon" })).not.toBe(defaultFavoriteListIcon);
    expect(favoriteListIcon({ icon: "" })).toBe(defaultFavoriteListIcon);
    expect(favoriteListIcon({ icon: "from-a-newer-client" })).toBe(defaultFavoriteListIcon);
    expect(favoriteListIcon({})).toBe(defaultFavoriteListIcon);
    expect(favoriteListIcon(null)).toBe(defaultFavoriteListIcon);
  });
});

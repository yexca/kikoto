import type { LibraryLayout, LibraryMode } from "@/lib/api";

export type LibraryLayoutSummary = {
  mode: LibraryMode;
  /** Storage locations the library reads: the data folder, or each registered pool. */
  total: number;
  online: number;
};

/** How many of the library's storage locations are online, for an at-a-glance status. */
export function libraryLayoutSummary(layout: LibraryLayout): LibraryLayoutSummary {
  const mode = layout.mode === "pools" ? "pools" : "standard";
  return {
    mode,
    total: layout.pools.length,
    online: layout.pools.filter((pool) => pool.online).length,
  };
}

export type CatalogSyncState = "never" | "attention" | "synced" | "not_applicable";

const legacyStateMap: Record<string, CatalogSyncState> = {
  fresh: "synced",
  pending: "never",
  stale: "attention",
  excluded: "not_applicable",
};

export function normalizeCatalogSyncState(state: unknown): CatalogSyncState {
  if (typeof state !== "string") return "attention";

  const normalized = state.trim().toLowerCase();
  if (
    normalized === "never" ||
    normalized === "attention" ||
    normalized === "synced" ||
    normalized === "not_applicable"
  ) {
    return normalized;
  }
  return legacyStateMap[normalized] ?? "attention";
}

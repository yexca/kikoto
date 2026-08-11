import { Badge } from "@/components/ui/badge";
import { normalizeCatalogSyncState, type CatalogSyncState } from "@/lib/catalogSyncState";

const syncLabels: Record<CatalogSyncState, string> = {
  never: "Never",
  attention: "Attention",
  synced: "Synced",
  not_applicable: "Not applicable",
};

export function CatalogSyncBadge({ state }: { state?: CatalogSyncState | string | null }) {
  const normalizedState = normalizeCatalogSyncState(state);
  const variant =
    normalizedState === "synced" ? "success" : normalizedState === "not_applicable" ? "outline" : "warning";
  return <Badge variant={variant}>{syncLabels[normalizedState]}</Badge>;
}

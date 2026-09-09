import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { normalizeCatalogSyncState, type CatalogSyncState } from "@/lib/catalogSyncState";

const syncLabelKeys: Record<CatalogSyncState, string> = {
  never: "sync.never",
  attention: "sync.attention",
  synced: "sync.synced",
  not_applicable: "sync.notApplicable",
};

export function CatalogSyncBadge({ state }: { state?: CatalogSyncState | string | null }) {
  const { t } = useTranslation();
  const normalizedState = normalizeCatalogSyncState(state);
  const variant =
    normalizedState === "synced" ? "success" : normalizedState === "not_applicable" ? "outline" : "warning";
  return <Badge variant={variant}>{t(syncLabelKeys[normalizedState])}</Badge>;
}

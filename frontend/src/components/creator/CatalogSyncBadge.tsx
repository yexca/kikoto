import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { normalizeCatalogSyncState, type CatalogSyncState } from "@/lib/catalogSyncState";

const syncLabelKeys: Record<CatalogSyncState, string> = {
  never: "sync.never",
  attention: "sync.attention",
  synced: "sync.synced",
  not_applicable: "sync.notApplicable",
};

const syncDotClassNames: Record<CatalogSyncState, string> = {
  never: "bg-warning",
  attention: "bg-warning",
  synced: "bg-success",
  not_applicable: "bg-muted-foreground/50",
};

export function CatalogSyncBadge({
  state,
  appearance = "badge",
  className = "",
}: {
  state?: CatalogSyncState | string | null;
  appearance?: "badge" | "dot";
  className?: string;
}) {
  const { t } = useTranslation();
  const normalizedState = normalizeCatalogSyncState(state);
  if (appearance === "dot") {
    return (
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground ${className}`}>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${syncDotClassNames[normalizedState]}`}
          aria-hidden="true"
        />
        {t(syncLabelKeys[normalizedState])}
      </span>
    );
  }
  const variant =
    normalizedState === "synced" ? "success" : normalizedState === "not_applicable" ? "outline" : "warning";
  return (
    <Badge variant={variant} className={className}>
      {t(syncLabelKeys[normalizedState])}
    </Badge>
  );
}

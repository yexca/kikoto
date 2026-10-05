import { FilterX, Heart, ListMusic, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

export function FavoriteLoadError({
  message,
  compact = false,
  onRetry,
}: {
  message: string;
  compact?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`${compact ? "flex min-h-12 items-center justify-between gap-3 px-3 py-2" : "grid min-h-40 place-items-center gap-3 px-4 py-8 text-center"} rounded-[var(--radius)] border border-error-border bg-error-surface`}
      role="alert"
    >
      <p className="text-sm text-error-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

export type FavoriteEmptyReason = "filtered" | "shelf" | "list";

/** Distinguishes an empty collection, an empty list, and filters that match nothing. */
export function EmptyFavorites({
  reason,
  onClearFilters,
  onBrowseLibrary,
}: {
  reason: FavoriteEmptyReason;
  onClearFilters: () => void;
  onBrowseLibrary: () => void;
}) {
  const { t } = useTranslation();
  const Icon = reason === "filtered" ? Search : reason === "list" ? ListMusic : Heart;
  return (
    <div className="grid min-h-72 place-items-center rounded-[var(--radius)] border border-dashed bg-card/50 p-6 text-center">
      <div className="max-w-sm space-y-3">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <h3 className="text-base font-semibold">
          {reason === "filtered"
            ? t("favorites.noMatches")
            : reason === "list"
              ? t("favorites.emptyListTitle")
              : t("favorites.noFavoriteWorks")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {reason === "filtered"
            ? t("favorites.filteredDescription")
            : reason === "list"
              ? t("favorites.emptyListDescription")
              : t("favorites.emptyDescription")}
        </p>
        {reason === "filtered" ? (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            <FilterX className="h-4 w-4" />
            {t("favorites.clearFilters")}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onBrowseLibrary}>
            {t("favorites.browseLibrary")}
          </Button>
        )}
      </div>
    </div>
  );
}

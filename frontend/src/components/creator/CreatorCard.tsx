import { Heart, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserTagRow, type UserTag } from "@/components/UserTagRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CatalogSyncBadge } from "@/components/creator/CatalogSyncBadge";
import { assetURL } from "@/lib/api";
import type { CatalogSyncState } from "@/lib/catalogSyncState";

export const creatorCardMinHeightClassName = "min-h-32";

export type CreatorLatestWork = {
  primaryCode: string;
  title: string;
  releaseDate: string | null;
  coverUrl: string;
};

export type CreatorSourceSummary = {
  key: string;
  sourceId?: number | null;
  displayName: string;
  status: string;
  count: number;
};

export function CreatorCard({
  name,
  identityLabel,
  aliases,
  showAliases = true,
  latestWork,
  favorite,
  userTags,
  syncState,
  workCount,
  availabilitySummary,
  availabilityCounts,
  unavailableCount,
  sources,
  onOpen,
  onFavoriteToggle,
  onTagsSave,
}: {
  name: string;
  identityLabel?: string;
  aliases: string[];
  showAliases?: boolean;
  latestWork: CreatorLatestWork | null;
  favorite: boolean;
  userTags: UserTag[];
  syncState: CatalogSyncState;
  workCount: number;
  availabilitySummary?: { available: number; total: number };
  availabilityCounts?: { local: number; remote: number };
  unavailableCount: number;
  sources: CreatorSourceSummary[];
  onOpen: () => void;
  onFavoriteToggle: () => void;
  onTagsSave: (tags: string[]) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [latestWork?.coverUrl]);
  const visibleAliases = showAliases ? aliases.filter((alias) => alias && alias !== name) : [];
  const availableSources = creatorSourceTags(sources);
  const showUnavailableCount = unavailableCount > 0 && availableSources.length > 0;

  return (
    <Card className="h-full overflow-hidden transition-colors hover:border-primary/40">
      <CardContent className={`flex h-full ${creatorCardMinHeightClassName} gap-3.5 p-3.5`}>
        <button
          type="button"
          className="group relative aspect-[4/3] w-28 shrink-0 self-start overflow-hidden rounded-md bg-muted ring-1 ring-border/60 sm:w-32"
          onClick={onOpen}
          aria-label={t("creator.open", { name })}
          title={t("creator.open", { name })}
        >
          {latestWork?.coverUrl && !imageFailed ? (
            <img
              src={assetURL(latestWork.coverUrl)}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none"
              loading="lazy"
              decoding="async"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-1 bg-secondary px-2 text-secondary-foreground">
              <ImageOff className="h-5 w-5" />
              <span className="text-2xs font-medium">{t("creator.noCover")}</span>
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-start gap-1">
            <button type="button" className="min-w-0 flex-1 rounded-sm text-left" onClick={onOpen}>
              <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-snug">{name}</h3>
              {visibleAliases.length > 0 && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={visibleAliases.join(", ")}>
                  {visibleAliases.join(", ")}
                </p>
              )}
              {(identityLabel || latestWork) && (
                <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                  {identityLabel && <span className="shrink-0 font-mono tracking-tight">{identityLabel}</span>}
                  {identityLabel && latestWork && <span aria-hidden="true">·</span>}
                  {latestWork && (
                    <span className="whitespace-nowrap">{t("creator.latest", { code: latestWork.primaryCode })}</span>
                  )}
                </p>
              )}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`-mr-1 -mt-1 h-8 w-8 shrink-0 ${favorite ? "text-primary hover:text-primary" : "text-muted-foreground"}`}
              aria-label={favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              aria-pressed={favorite}
              title={favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
              onClick={onFavoriteToggle}
            >
              <Heart className={`h-4 w-4 ${favorite ? "fill-current" : ""}`} />
            </Button>
          </div>

          <UserTagRow tags={userTags} onSave={onTagsSave} className="mt-2" />

          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-xs text-muted-foreground">
            <CatalogSyncBadge state={syncState} appearance="dot" />
            {availabilitySummary ? (
              <span
                className={`tabular-nums ${availabilitySummary.available > 0 ? "text-success-foreground" : "text-warning-foreground"}`}
              >
                {t("creator.available", availabilitySummary)}
              </span>
            ) : availabilityCounts ? (
              <>
                <span className={`tabular-nums ${availabilityCounts.local > 0 ? "text-foreground" : ""}`}>
                  {t("creator.local", { count: availabilityCounts.local })}
                </span>
                <span className={`tabular-nums ${availabilityCounts.remote > 0 ? "text-foreground" : ""}`}>
                  {t("creator.remote", { count: availabilityCounts.remote })}
                </span>
              </>
            ) : (
              <>
                {availableSources.length > 0 ? (
                  availableSources.map((source) => (
                    <span key={source.key} className={source.key === "local" ? "text-foreground" : ""}>
                      {source.displayName}
                      {source.count > 0 ? ` ${source.count}` : ""}
                    </span>
                  ))
                ) : (
                  <span className="text-warning-foreground">{t("creator.unavailable")}</span>
                )}
                {showUnavailableCount && (
                  <span className="text-warning-foreground">
                    {t("creator.unavailableCount", { count: unavailableCount })}
                  </span>
                )}
                <span className="ml-auto whitespace-nowrap tabular-nums">
                  {t("creator.works", { count: workCount })}
                </span>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function CreatorCardSkeleton() {
  return (
    <Card className="h-full">
      <CardContent className={`flex h-full ${creatorCardMinHeightClassName} gap-3.5 p-3.5`}>
        <div className="aspect-[4/3] w-28 shrink-0 animate-pulse rounded-md bg-muted sm:w-32" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-auto h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

export function CreatorCollectionSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("creator.loading");
  return (
    <div className={creatorCollectionClassName} role="status" aria-label={resolvedLabel} aria-busy="true">
      <CreatorCardSkeleton />
      <div className="hidden lg:block" aria-hidden="true">
        <CreatorCardSkeleton />
      </div>
    </div>
  );
}

export const creatorCollectionClassName = `grid ${creatorCardMinHeightClassName} gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,21rem),1fr))]`;

function creatorSourceTags(sources: CreatorSourceSummary[]) {
  const available = sources.filter((source) => source.status === "available" || source.count > 0);
  const hasSpecificRemote = available.some(
    (source) => source.sourceId !== null && source.sourceId !== undefined && source.key !== "cache",
  );
  return hasSpecificRemote ? available.filter((source) => source.key !== "remote") : available;
}

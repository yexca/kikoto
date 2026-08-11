import { Heart, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";

import { UserTagRow, type UserTag } from "@/components/UserTagRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { assetURL } from "@/lib/api";

export const creatorCardMinHeightClassName = "min-h-60";

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
  syncState?: string;
  workCount: number;
  availabilitySummary?: { available: number; total: number };
  unavailableCount: number;
  sources: CreatorSourceSummary[];
  onOpen: () => void;
  onFavoriteToggle: () => void;
  onTagsSave: (tags: string[]) => Promise<void> | void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [latestWork?.coverUrl]);
  const visibleAliases = showAliases ? aliases.filter((alias) => alias && alias !== name) : [];
  const availableSources = creatorSourceTags(sources);
  const showUnavailableCount = unavailableCount > 0 && availableSources.length > 0;

  return (
    <Card className="h-full overflow-hidden transition-colors hover:border-primary/50">
      <CardContent className={`flex h-full ${creatorCardMinHeightClassName} gap-4 p-4`}>
        <button
          type="button"
          className="group relative aspect-[4/3] w-28 shrink-0 self-start overflow-hidden rounded-md border bg-muted sm:w-[7.5rem]"
          onClick={onOpen}
          aria-label={`Open ${name}`}
          title={`Open ${name}`}
        >
          {latestWork?.coverUrl && !imageFailed ? (
            <img
              src={assetURL(latestWork.coverUrl)}
              alt=""
              className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className="flex h-full flex-col items-center justify-center gap-1 bg-secondary px-2 text-secondary-foreground">
              <ImageOff className="h-5 w-5" />
              <span className="text-[11px] font-medium">No cover</span>
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {identityLabel && <Badge variant="outline">{identityLabel}</Badge>}
                {latestWork && <span className="truncate">Latest {latestWork.primaryCode}</span>}
              </div>
              <h3 className="mt-1 line-clamp-2 text-base font-semibold leading-5">{name}</h3>
              {visibleAliases.length > 0 && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={visibleAliases.join(", ")}>
                  {visibleAliases.join(", ")}
                </p>
              )}
            </button>
            <Button
              type="button"
              variant={favorite ? "default" : "outline"}
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={favorite ? "Remove favorite" : "Add favorite"}
              title={favorite ? "Remove favorite" : "Add favorite"}
              onClick={onFavoriteToggle}
            >
              <Heart className={`h-4 w-4 ${favorite ? "fill-current" : ""}`} />
            </Button>
          </div>

          <UserTagRow tags={userTags} compact onSave={onTagsSave} className="mt-2" />

          <div className="mt-auto flex flex-wrap items-center gap-1 border-t pt-2 text-xs text-muted-foreground">
            {syncState && <SyncBadge state={syncState} />}
            {availabilitySummary ? (
              <Badge variant={availabilitySummary.available > 0 ? "success" : "warning"} className="tabular-nums">
                Available {availabilitySummary.available}/{availabilitySummary.total}
              </Badge>
            ) : (
              <>
                {availableSources.length > 0 ? (
                  availableSources.map((source) => (
                    <Badge key={source.key} variant={source.key === "local" ? "secondary" : "outline"}>
                      {source.displayName}
                      {source.count > 0 ? ` ${source.count}` : ""}
                    </Badge>
                  ))
                ) : (
                  <Badge variant="warning">Unavailable</Badge>
                )}
                {showUnavailableCount && <Badge variant="warning">{unavailableCount} unavailable</Badge>}
                <span className="ml-auto whitespace-nowrap tabular-nums">{workCount} works</span>
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
      <CardContent className={`flex h-full ${creatorCardMinHeightClassName} gap-4 p-4`}>
        <div className="aspect-[4/3] w-28 shrink-0 animate-pulse rounded-md bg-muted sm:w-[7.5rem]" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="h-5 w-24 animate-pulse rounded-full bg-muted" />
          <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-auto h-7 w-full animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

export function CreatorCollectionSkeleton({ label = "Loading creators" }: { label?: string }) {
  return (
    <div className={creatorCollectionClassName} role="status" aria-label={label} aria-busy="true">
      <CreatorCardSkeleton />
      <div className="hidden lg:block" aria-hidden="true">
        <CreatorCardSkeleton />
      </div>
    </div>
  );
}

export const creatorCollectionClassName = `grid ${creatorCardMinHeightClassName} gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))]`;

function creatorSourceTags(sources: CreatorSourceSummary[]) {
  const available = sources.filter((source) => source.status === "available" || source.count > 0);
  const hasSpecificRemote = available.some(
    (source) => source.sourceId !== null && source.sourceId !== undefined && source.key !== "cache",
  );
  return hasSpecificRemote ? available.filter((source) => source.key !== "remote") : available;
}

function SyncBadge({ state }: { state: string }) {
  const label =
    state === "fresh"
      ? "Synced"
      : state === "stale"
        ? "Needs refresh"
        : state === "excluded"
          ? "Excluded"
          : "Never synced";
  return <Badge variant={state === "fresh" || state === "excluded" ? "secondary" : "warning"}>{label}</Badge>;
}

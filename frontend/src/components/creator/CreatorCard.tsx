import { Heart, ImageOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { UserTagRow, type UserTag } from "@/components/UserTagRow";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AvailabilityMeter } from "@/components/creator/AvailabilityMeter";
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

export type CreatorAvailability = {
  /** Every work known for the creator. */
  total: number;
  /** Works with a local copy. */
  local: number;
  /** Works with any playable copy, local or remote. */
  available: number;
};

/**
 * A circle or voice actor as a cover-led tile: the creator's cover, the name,
 * personal tags, and how much of the catalog can be played.
 */
export function CreatorCard({
  name,
  identityLabel,
  aliases,
  showAliases = true,
  coverUrl,
  latestWork,
  favorite,
  userTags,
  syncState,
  availability,
  availabilitySummary,
  availabilityCounts,
  onOpen,
  onFavoriteToggle,
  onTagsSave,
  tagScope,
}: {
  name: string;
  identityLabel?: string;
  aliases: string[];
  showAliases?: boolean;
  /** The chosen work's cover, or the latest work's. */
  coverUrl: string;
  latestWork: CreatorLatestWork | null;
  favorite: boolean;
  userTags: UserTag[];
  syncState: CatalogSyncState;
  availability: CreatorAvailability;
  /** Caption as one ratio; otherwise `availabilityCounts` names local and remote. */
  availabilitySummary?: { available: number; total: number };
  availabilityCounts?: { local: number; remote: number };
  onOpen: () => void;
  onFavoriteToggle: () => void;
  onTagsSave: (tags: string[]) => Promise<void> | void;
  tagScope: "circle" | "voice";
}) {
  const { t } = useTranslation();
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [coverUrl]);
  const visibleAliases = showAliases ? aliases.filter((alias) => alias && alias !== name) : [];
  const latestDate = latestWork?.releaseDate?.slice(0, 10) ?? "";
  const latestLabel = !latestWork
    ? ""
    : latestDate
      ? t("creator.latestRelease", { date: latestDate })
      : t("creator.latest", { code: latestWork.primaryCode });
  const remoteOnly = Math.max(0, availability.available - availability.local);
  const meterLabel = t("creator.availabilityBreakdown", {
    local: availability.local,
    remote: remoteOnly,
    missing: Math.max(0, availability.total - availability.available),
  });

  return (
    <Card className="group/creator relative flex h-full flex-col overflow-hidden transition-colors hover:border-primary/40">
      <button
        type="button"
        className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden border-b bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={t("creator.open", { name })}
        title={t("creator.open", { name })}
      >
        {coverUrl && !imageFailed ? (
          <img
            src={assetURL(coverUrl)}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover/creator:scale-[1.03] motion-reduce:transition-none"
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
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={`absolute right-1.5 top-1.5 h-8 w-8 rounded-full border bg-card/85 backdrop-blur-sm hover:bg-card ${
          favorite ? "text-primary hover:text-primary" : "text-muted-foreground"
        }`}
        aria-label={favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
        aria-pressed={favorite}
        title={favorite ? t("creator.removeFavorite") : t("creator.addFavorite")}
        onClick={onFavoriteToggle}
      >
        <Heart className={`h-4 w-4 ${favorite ? "fill-current" : ""}`} />
      </Button>

      <div className="flex min-w-0 flex-1 flex-col p-2.5 sm:p-3">
        <button type="button" className="min-w-0 rounded-sm text-left" onClick={onOpen} tabIndex={-1}>
          <h3 className="line-clamp-2 text-[0.95rem] font-semibold leading-5" title={name}>
            {name}
          </h3>
          {visibleAliases.length > 0 && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={visibleAliases.join(", ")}>
              {visibleAliases.join(", ")}
            </p>
          )}
          <p
            className="mt-1 flex h-4 min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            title={latestWork ? `${latestWork.primaryCode} ${latestWork.title}` : undefined}
          >
            {identityLabel && (
              <span className="hidden shrink-0 font-mono tracking-tight sm:inline">{identityLabel}</span>
            )}
            {identityLabel && latestLabel && (
              <span className="hidden sm:inline" aria-hidden="true">
                ·
              </span>
            )}
            {latestLabel && <span className="min-w-0 truncate">{latestLabel}</span>}
          </p>
        </button>

        <UserTagRow tags={userTags} scope={tagScope} onSave={onTagsSave} className="mt-2 min-h-7" />

        <div className="mt-auto pt-2.5">
          <AvailabilityMeter
            total={availability.total}
            local={availability.local}
            available={availability.available}
            label={meterLabel}
          />
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {availabilitySummary ? (
              <span
                className={`whitespace-nowrap tabular-nums ${availabilitySummary.available > 0 ? "text-success-foreground" : ""}`}
              >
                {t("creator.available", availabilitySummary)}
              </span>
            ) : availabilityCounts ? (
              <span className="flex min-w-0 gap-x-2">
                <span
                  className={`whitespace-nowrap tabular-nums ${availabilityCounts.local > 0 ? "text-foreground" : ""}`}
                >
                  {t("creator.local", { count: availabilityCounts.local })}
                </span>
                <span
                  className={`whitespace-nowrap tabular-nums ${availabilityCounts.remote > 0 ? "text-foreground" : ""}`}
                >
                  {t("creator.remote", { count: availabilityCounts.remote })}
                </span>
              </span>
            ) : null}
            <CatalogSyncBadge state={syncState} appearance="dot" />
          </div>
        </div>
      </div>
    </Card>
  );
}

export function CreatorCardSkeleton() {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="aspect-[4/3] w-full shrink-0 animate-pulse border-b bg-muted" />
      <div className="flex flex-1 flex-col p-2.5 sm:p-3">
        <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
        <div className="mt-1 h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-7 w-7 animate-pulse rounded-md bg-muted" />
        <div className="mt-auto pt-2.5">
          <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
          <div className="mt-1.5 h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </Card>
  );
}

export function CreatorCollectionSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("creator.loading");
  return (
    <div
      className={`skeleton-reveal ${creatorCollectionClassName}`}
      role="status"
      aria-label={resolvedLabel}
      aria-busy="true"
    >
      <CreatorCardSkeleton />
      <div aria-hidden="true">
        <CreatorCardSkeleton />
      </div>
      <div className="hidden sm:block" aria-hidden="true">
        <CreatorCardSkeleton />
      </div>
    </div>
  );
}

/** Two columns on a phone, then as many tiles as fit; `auto-fill` keeps a short result from stretching. */
export const creatorCollectionClassName =
  "grid grid-cols-2 gap-2.5 sm:gap-3 sm:[grid-template-columns:repeat(auto-fill,minmax(13.5rem,1fr))]";

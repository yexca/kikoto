import { BookmarkCheck, Heart, ListMusic, Mic2, UsersRound, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { assetURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import type { FavoriteShelfKind, FavoriteShelfProgress } from "./favoriteShelfModel";

export type FavoriteHeaderKind = FavoriteShelfKind | "circles" | "voices";

const kindIcons = {
  all: Heart,
  marked: BookmarkCheck,
  list: ListMusic,
  circles: UsersRound,
  voices: Mic2,
} as const;

export function FavoriteShelfHeader({
  kind,
  listIcon,
  eyebrow: eyebrowOverride,
  title,
  description,
  countLabel,
  covers,
  progress,
  actions,
  compact = false,
}: {
  kind: FavoriteHeaderKind;
  /** A user list's chosen icon, in place of the default list icon. */
  listIcon?: LucideIcon;
  /** Names the shelf kind in place of the default, such as a smart list. */
  eyebrow?: string;
  title: string;
  description?: string;
  /** Null while the shelf count is still unknown. */
  countLabel: string | null;
  covers: string[];
  progress?: FavoriteShelfProgress | null;
  actions?: ReactNode;
  /**
   * The phone header: a single row beside small artwork. The shelf strip above
   * already names the shelf kind, so the eyebrow folds into the stats line.
   */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const Icon = listIcon ?? kindIcons[kind];
  if (compact) {
    return (
      <header className="flex items-center gap-3">
        <ShelfArtwork kind={kind} icon={Icon} covers={covers} compact />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <h2 className="min-w-0 truncate text-lg font-semibold leading-7 tracking-tight" title={title}>
              {title}
            </h2>
            {actions}
          </div>
          {/* One line is always reserved, so switching shelves never moves the results below. */}
          <p className="min-h-4 truncate text-xs leading-4 text-muted-foreground" title={description || undefined}>
            {eyebrowOverride && <span className="font-medium text-primary">{eyebrowOverride}</span>}
            {eyebrowOverride && description && " · "}
            {description}
          </p>
          <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {countLabel === null ? (
              <span className="h-3 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />
            ) : (
              <span className="shrink-0 font-medium text-foreground">{countLabel}</span>
            )}
            {progress && progress.total > 0 && <ShelfListenedMeter progress={progress} compact />}
          </div>
        </div>
      </header>
    );
  }
  const eyebrow =
    eyebrowOverride ??
    (kind === "all"
      ? t("favorites.shelfKindCollection")
      : kind === "marked"
        ? t("favorites.shelfKindSystem")
        : kind === "list"
          ? t("favorites.shelfKindList")
          : t("favorites.creators"));
  return (
    <header className="flex items-start gap-4 sm:gap-5">
      <ShelfArtwork kind={kind} icon={Icon} covers={covers} />
      <div className="min-w-0 flex-1 self-center">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          {eyebrow}
        </p>
        {/* Actions sit beside the title, so a list's edit button never narrows the stats below. */}
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight sm:text-2xl" title={title}>
            {title}
          </h2>
          {actions}
        </div>
        {/* One line is always reserved, so switching shelves never moves the results below. */}
        <p className="mt-1 min-h-5 truncate text-sm text-muted-foreground" title={description || undefined}>
          {description}
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {countLabel === null ? (
            <span className="h-3 w-16 animate-pulse rounded bg-muted" aria-hidden="true" />
          ) : (
            <span className="font-medium text-foreground">{countLabel}</span>
          )}
          {progress && progress.total > 0 && <ShelfListenedMeter progress={progress} />}
          {progress && progress.listening > 0 && (
            <span>{t("favorites.listeningCount", { count: progress.listening })}</span>
          )}
        </div>
      </div>
    </header>
  );
}

/** Compact fills the rest of its row and states the share listened as a percentage. */
function ShelfListenedMeter({ progress, compact = false }: { progress: FavoriteShelfProgress; compact?: boolean }) {
  const { t } = useTranslation();
  const label = t("favorites.listenedOf", { listened: progress.listened, total: progress.total });
  return (
    <span className={cn("inline-flex items-center gap-2", compact && "min-w-0 flex-1")} title={label}>
      <span
        role="meter"
        aria-label={t("favorites.listened")}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.listened}
        aria-valuetext={label}
        className={cn(
          "relative h-1.5 overflow-hidden rounded-full bg-muted",
          compact ? "min-w-8 flex-1" : "w-20 sm:w-28",
        )}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-success transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${progress.percent}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums">
        {compact ? t("favorites.listenedPercent", { percent: progress.percent }) : label}
      </span>
    </span>
  );
}

/** Shelf artwork: a cover mosaic for works shelves, a quiet icon tile otherwise. */
function ShelfArtwork({
  kind,
  icon: Icon,
  covers,
  compact = false,
}: {
  kind: FavoriteHeaderKind;
  icon: LucideIcon;
  covers: string[];
  compact?: boolean;
}) {
  const tile = cn(
    "shrink-0 overflow-hidden",
    compact ? "h-16 w-16 rounded-[calc(var(--radius)-2px)]" : "h-20 w-20 rounded-[var(--radius)] sm:h-28 sm:w-28",
  );
  if (kind === "circles" || kind === "voices" || covers.length === 0) {
    return (
      <div className={cn(tile, "grid place-items-center border bg-primary/5 text-primary")} aria-hidden="true">
        <Icon className={compact ? "h-7 w-7" : "h-8 w-8 sm:h-10 sm:w-10"} strokeWidth={1.5} />
      </div>
    );
  }
  const mosaic = covers.length >= 4 ? covers.slice(0, 4) : covers.slice(0, 1);
  return (
    <div
      className={cn(tile, "grid bg-muted shadow-sm ring-1 ring-foreground/5", mosaic.length > 1 && "grid-cols-2")}
      aria-hidden="true"
    >
      {mosaic.map((cover) => (
        <img
          key={cover}
          src={assetURL(cover)}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  );
}

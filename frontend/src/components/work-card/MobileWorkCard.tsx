import { AudioLines, Headphones, MicVocal, Star } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent } from "@/components/ui/card";
import { useLocale } from "@/i18n/LocaleProvider";
import { assetURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import {
  WorkCardAgeRating,
  WorkCardIndicators,
  WorkCardTags,
  availabilityDotClassName,
  coverChipClassName,
  coverSourceIcon,
  formatCompactCount,
  formatDiscount,
  formatPrice,
  formatRating,
  useWorkCardEntityActions,
  type WorkCardBadge,
  type WorkCardShellProps,
  type WorkCardViewModel,
} from "./WorkCardShell";

/**
 * Phone layouts for a work card. `row` puts a small cover beside the facts so a
 * single column scans like a track list; `tile` is the two-column grid, which
 * keeps the cover dominant and drops tags and credits to stay short.
 */
export type MobileWorkCardLayout = "row" | "tile";

export function MobileWorkCardShell({
  layout,
  work,
  selection,
  footer,
  canOpen = true,
  onOpen,
  onCircleOpen,
  onVoiceOpen,
  onSeriesOpen,
  onTagOpen,
  onRecommendationOpen,
}: WorkCardShellProps & { layout: MobileWorkCardLayout }) {
  const { t } = useTranslation();
  const { circleOpen, voiceOpen } = useWorkCardEntityActions(work, { onCircleOpen, onVoiceOpen, onSeriesOpen });
  const interactive = Boolean(onOpen) && canOpen;
  const hasTags = work.dlsiteTags.length > 0 || (work.userTags?.length ?? 0) > 0;
  const cover = (
    <MobileCover work={work} layout={layout} selection={selection} onRecommendationOpen={onRecommendationOpen} />
  );
  return (
    <Card
      className="group h-full overflow-hidden transition-[border-color,transform] duration-150 focus-within:border-primary/40 active:scale-[var(--press-scale)] motion-reduce:transition-none motion-reduce:active:scale-100"
      data-testid="work-card"
    >
      <CardContent className="flex h-full flex-col rounded-[inherit] p-0">
        <div
          className={cn(
            "flex flex-1 flex-col rounded-t-[inherit] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            interactive ? "cursor-pointer" : "cursor-default",
          )}
          role={interactive ? "button" : undefined}
          tabIndex={interactive ? 0 : undefined}
          onClick={interactive ? onOpen : undefined}
          onKeyDown={
            interactive
              ? (event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen?.();
                  }
                }
              : undefined
          }
        >
          {layout === "row" ? (
            <>
              <div className="flex gap-3 p-2.5 pb-2">
                <div className="w-[7.5rem] shrink-0">{cover}</div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <CodeLine work={work} />
                  <h3 className="line-clamp-2 text-[0.9375rem] font-semibold leading-5" title={work.title}>
                    {work.title}
                  </h3>
                  <CreditLine work={work} onCircleOpen={circleOpen} onVoiceOpen={voiceOpen} />
                  <MetricLine work={work} className="mt-auto pt-0.5" />
                </div>
              </div>
              {hasTags && (
                <div className="px-2.5 pb-2">
                  <WorkCardTags
                    dlsiteTags={work.dlsiteTags}
                    userTags={work.userTags ?? []}
                    emptyLabel={t("workCard.noDlsiteTags")}
                    singleRow
                    onTagOpen={onTagOpen}
                  />
                </div>
              )}
              <ProgressLine work={work} />
            </>
          ) : (
            <>
              <div className="p-1.5 pb-0">{cover}</div>
              <div className="flex flex-1 flex-col gap-1 px-2.5 pb-2.5 pt-2">
                <CodeLine work={work} />
                <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5" title={work.title}>
                  {work.title}
                </h3>
                <CreditLine work={work} onCircleOpen={circleOpen} />
                <MetricLine work={work} hidePrice className="mt-auto pt-0.5" />
              </div>
            </>
          )}
        </div>
        {footer}
      </CardContent>
    </Card>
  );
}

/** Loading placeholder with the same footprint as the matching card layout. */
export function MobileWorkCardSkeleton({ layout }: { layout: MobileWorkCardLayout }) {
  const bar = "animate-pulse rounded bg-muted";
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card" aria-hidden="true">
      {layout === "row" ? (
        <>
          <div className="flex gap-3 p-2.5 pb-2">
            <div className="aspect-[4/3] w-[7.5rem] shrink-0 animate-pulse rounded-[calc(var(--radius)-4px)] bg-muted" />
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
              <div className={cn(bar, "h-3 w-1/3")} />
              <div className={cn(bar, "h-4 w-full")} />
              <div className={cn(bar, "h-4 w-2/3")} />
              <div className={cn(bar, "h-3 w-1/2")} />
            </div>
          </div>
          <div className="flex gap-1.5 px-2.5 pb-2">
            <div className={cn(bar, "h-6 w-14")} />
            <div className={cn(bar, "h-6 w-20")} />
            <div className={cn(bar, "h-6 w-16")} />
          </div>
          <div className="mt-auto h-10 border-t border-border/40" />
        </>
      ) : (
        <>
          <div className="p-1.5 pb-0">
            <div className="aspect-[4/3] animate-pulse rounded-[calc(var(--radius)-4px)] bg-muted" />
          </div>
          <div className="flex flex-1 flex-col gap-2 px-2.5 pb-2.5 pt-2">
            <div className={cn(bar, "h-3 w-1/2")} />
            <div className={cn(bar, "h-4 w-full")} />
            <div className={cn(bar, "h-4 w-2/3")} />
            <div className={cn(bar, "h-3 w-1/2")} />
          </div>
          <div className="mt-auto h-11 border-t border-border/70" />
        </>
      )}
    </div>
  );
}

function MobileCover({
  work,
  layout,
  selection,
  onRecommendationOpen,
}: {
  work: WorkCardViewModel;
  layout: MobileWorkCardLayout;
  selection?: ReactNode;
  onRecommendationOpen?: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const price = work.price ?? null;
  const progress = work.progress ?? null;
  const highlighted = work.recommendationHighlighted ?? true;
  const recommendationClassName = cn(
    coverChipClassName,
    "absolute left-1 top-1 h-5 gap-0.5 px-1.5 text-2xs tabular-nums",
    !highlighted && "font-medium text-muted-foreground",
  );
  const recommendationContent = (
    <>
      <Star
        className={cn("h-3 w-3", highlighted ? "fill-primary text-primary" : "text-muted-foreground")}
        aria-hidden="true"
      />
      {Number.isFinite(work.recommendationScore) && <span>{work.recommendationScore}</span>}
    </>
  );
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-[calc(var(--radius)-4px)] bg-muted after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-inset after:ring-foreground/5">
      {work.coverUrl ? (
        <img
          src={assetURL(work.coverUrl)}
          alt=""
          className={cn("h-full w-full", layout === "row" ? "object-cover" : "object-contain")}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 bg-secondary text-secondary-foreground">
          <AudioLines className="h-6 w-6 opacity-50" aria-hidden="true" />
          <span className="max-w-full truncate px-2 font-mono text-2xs opacity-70">
            {work.code || t("workCard.source")}
          </span>
        </div>
      )}
      {work.recommended &&
        (onRecommendationOpen ? (
          <button
            type="button"
            className={recommendationClassName}
            title={t("workCard.explainRecommendationScore")}
            aria-label={`${t("workCard.explainRecommendationScore")} ${work.recommendationScore ?? 0}`}
            onClick={(event) => {
              event.stopPropagation();
              onRecommendationOpen();
            }}
          >
            {recommendationContent}
          </button>
        ) : (
          <div
            className={cn(
              recommendationClassName,
              work.recommendationRevealDelay !== undefined && "recommendation-reveal",
            )}
            style={
              work.recommendationRevealDelay === undefined
                ? undefined
                : { animationDelay: `${work.recommendationRevealDelay}ms` }
            }
            title={t("workCard.recommendedForYou")}
            aria-label={t("workCard.recommendedForYou")}
          >
            {recommendationContent}
          </div>
        ))}
      {selection}
      <div className="absolute inset-x-1 bottom-1 flex items-end gap-1">
        <CoverSourceMarks work={work} />
        {layout === "tile" && price !== null && (
          <span className={cn(coverChipClassName, "ml-auto h-5 shrink-0 px-1.5 text-2xs tabular-nums")}>
            {price === 0 ? t("workCard.free") : formatPrice(price, work.priceCurrency, resolvedLocale)}
          </span>
        )}
      </div>
      {progress && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-foreground/15" aria-hidden="true">
          <div className="h-full bg-primary" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
    </div>
  );
}

// A cover this small has room for one labeled mark or two icon marks; the rest
// are summarized as a count and listed in the tooltip.
function CoverSourceMarks({ work }: { work: WorkCardViewModel }) {
  const { t } = useTranslation();
  const items: WorkCardBadge[] =
    work.sourceBadges.length > 0 || work.sourceUnavailableFallback === false
      ? work.sourceBadges
      : [{ key: "source:unavailable", label: t("workCard.sourceUnavailable"), variant: "warning" }];
  if (items.length === 0) return null;
  const chipClassName = cn(coverChipClassName, "h-5 text-2xs font-medium");
  if (work.sourceBadgeStyle === "icon") {
    const visible = items.slice(0, 2);
    const hidden = items.slice(2);
    return (
      <div className="flex min-w-0 items-center gap-1">
        {visible.map((badge) => {
          const Icon = coverSourceIcon(badge);
          const label = badge.title && badge.title !== badge.label ? `${badge.label} (${badge.title})` : badge.label;
          return (
            <span
              key={badge.key ?? badge.label}
              role="img"
              aria-label={label}
              title={label}
              className={cn(
                chipClassName,
                "w-5 shrink-0 justify-center px-0",
                badge.variant === "warning" && "text-warning-foreground",
              )}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
            </span>
          );
        })}
        {hidden.length > 0 && (
          <span className={cn(chipClassName, "shrink-0 px-1.5")} title={hidden.map((badge) => badge.label).join(", ")}>
            +{hidden.length}
          </span>
        )}
      </div>
    );
  }
  const [first, ...rest] = items;
  return (
    <span
      className={cn(chipClassName, "min-w-0 gap-1 px-1.5")}
      title={items.map((badge) => badge.title ?? badge.label).join(", ")}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", availabilityDotClassName(first))} aria-hidden="true" />
      <span className="truncate">{first.label}</span>
      {rest.length > 0 && <span className="shrink-0 text-muted-foreground">+{rest.length}</span>}
    </span>
  );
}

function CodeLine({ work }: { work: WorkCardViewModel }) {
  const { t } = useTranslation();
  const codeText = work.code || t("workCard.source");
  return (
    <div className="flex min-h-4 min-w-0 items-center gap-1.5">
      <span
        className="min-w-0 truncate font-mono text-2xs font-medium tracking-wide text-muted-foreground"
        title={codeText}
      >
        {codeText}
      </span>
      <WorkCardAgeRating ageRating={work.ageRating} />
      <span className="ml-auto inline-flex shrink-0">
        <WorkCardIndicators
          hasLyrics={work.hasLyrics === true}
          hasPlaybackHistory={work.hasPlaybackHistory === true && !work.progress}
        />
      </span>
    </div>
  );
}

function CreditLine({
  work,
  onCircleOpen,
  onVoiceOpen,
}: {
  work: WorkCardViewModel;
  onCircleOpen?: () => void;
  onVoiceOpen?: (name: string) => void;
}) {
  const { t } = useTranslation();
  const circleLabel = !work.circle || work.circle === "Unknown circle" ? t("workCard.unknownCircle") : work.circle;
  const voices = onVoiceOpen ? (work.voiceActors ?? []) : [];
  const shownVoices = voices.slice(0, 2);
  const hiddenVoiceCount = voices.length - shownVoices.length;
  return (
    <div
      className="min-w-0 truncate text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
      title={[circleLabel, ...voices].join(" · ")}
    >
      {onCircleOpen ? (
        <button
          type="button"
          className="hover:text-primary"
          onClick={(event) => {
            event.stopPropagation();
            onCircleOpen();
          }}
        >
          {circleLabel}
        </button>
      ) : (
        <span>{circleLabel}</span>
      )}
      {shownVoices.length > 0 && (
        <>
          <span className="px-1 opacity-60" aria-hidden="true">
            ·
          </span>
          <MicVocal className="mr-0.5 inline h-3 w-3 align-[-0.125rem]" aria-hidden="true" />
          {shownVoices.map((name, index) => (
            <span key={name}>
              {index > 0 && ", "}
              <button
                type="button"
                className="hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  onVoiceOpen?.(name);
                }}
              >
                {name}
              </button>
            </span>
          ))}
          {hiddenVoiceCount > 0 && <span className="ml-1 tabular-nums">+{hiddenVoiceCount}</span>}
        </>
      )}
    </div>
  );
}

function MetricLine({
  work,
  hidePrice = false,
  className,
}: {
  work: WorkCardViewModel;
  hidePrice?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const rating = work.rating ?? null;
  const normalizedRating = rating !== null && Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : null;
  const ratingCount = work.ratingCount ?? null;
  const sales = work.sales ?? null;
  const price = work.price ?? null;
  const regularPrice = work.regularPrice ?? null;
  const discountedFrom =
    price !== null && price > 0 && regularPrice !== null && regularPrice > price ? regularPrice : null;
  const ratingLabel =
    normalizedRating === null
      ? t("workCard.noRating")
      : t("workCard.rating", { value: formatRating(normalizedRating, resolvedLocale) });
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground", className)}>
      <span
        className="inline-flex shrink-0 items-center gap-0.5"
        title={ratingLabel}
        role="img"
        aria-label={ratingLabel}
      >
        <Star className={cn("h-3 w-3", normalizedRating !== null && "fill-primary text-primary")} aria-hidden="true" />
        <span className="font-semibold tabular-nums text-foreground">
          {normalizedRating === null ? "--" : formatRating(normalizedRating, resolvedLocale)}
        </span>
        {ratingCount !== null && ratingCount >= 0 && (
          <span className="tabular-nums">({formatCompactCount(ratingCount, resolvedLocale)})</span>
        )}
      </span>
      {sales !== null && sales >= 0 && (
        <span className="inline-flex min-w-0 shrink items-center gap-1 truncate">
          <span className="truncate">{t("workCard.sales")}</span>
          <span className="font-semibold tabular-nums text-foreground">
            {formatCompactCount(sales, resolvedLocale)}
          </span>
        </span>
      )}
      {!hidePrice && price !== null && (
        <span className="ml-auto inline-flex shrink-0 items-baseline gap-1 tabular-nums">
          <span className={cn("font-semibold", price === 0 ? "text-primary" : "text-foreground")}>
            {price === 0 ? t("workCard.free") : formatPrice(price, work.priceCurrency, resolvedLocale)}
          </span>
          {discountedFrom !== null && (
            <span className="text-2xs font-medium text-primary">
              {formatDiscount(price, discountedFrom, resolvedLocale)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function ProgressLine({ work }: { work: WorkCardViewModel }) {
  const progress = work.progress;
  if (!progress) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 pb-2.5 text-2xs text-muted-foreground">
      <Headphones className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate tabular-nums" title={progress.label}>
        {progress.label}
      </span>
      <span className="shrink-0 font-medium tabular-nums text-foreground">{Math.round(progress.percent)}%</span>
    </div>
  );
}

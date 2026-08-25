import {
  BookmarkPlus,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  Headphones,
  History,
  Languages,
  ListMusic,
  MicVocal,
  PauseCircle,
  Repeat2,
  ShoppingBag,
  Star,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toastFromError, useToast } from "@/components/ui/toast";
import i18n, { intlLocaleFor, type ResolvedUiLocale } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";
import {
  api,
  assetURL,
  type FavoriteList,
  type ListeningStatus,
  type UserTag,
  type VoiceCredit,
  type WorkEntityLink,
} from "@/lib/api";
import { ageRatingPresentation } from "@/lib/ageRating";
import { NAVIGATION_EVENT, historyStateWithReturn } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";
import { visibleBadgeCountForRows } from "./tagLayout";

export type WorkCardBadge = {
  key?: string;
  label: string;
  variant?: "default" | "secondary" | "outline" | "warning";
  title?: string;
  onClick?: () => void;
};

export type WorkCardViewModel = {
  code: string;
  title: string;
  circle: string;
  circleExternalId?: string;
  ageRating?: string;
  voiceActors?: string[];
  voiceCredits?: VoiceCredit[];
  coverUrl?: string;
  rating?: number | null;
  ratingCount?: number | null;
  sales?: number | null;
  regularPrice?: number | null;
  price?: number | null;
  priceCurrency?: string;
  series?: string | null;
  hasAvailableNonOriginEdition?: boolean;
  hasPlaybackHistory?: boolean;
  dlsiteTags: WorkCardBadge[];
  userTags?: WorkCardBadge[];
  sourceBadges: WorkCardBadge[];
  recommended?: boolean;
  recommendationScore?: number;
};

export function WorkCardShell({
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
}: {
  work: WorkCardViewModel;
  selection?: ReactNode;
  footer?: ReactNode;
  canOpen?: boolean;
  onOpen?: () => void;
  onCircleOpen?: (externalId: string) => void;
  onVoiceOpen?: (name: string) => void;
  onSeriesOpen?: () => void;
  onTagOpen?: (tag: string) => void;
  onRecommendationOpen?: () => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [resolvingEntity, setResolvingEntity] = useState<WorkEntityLink["kind"] | null>(null);
  const resolveEntity = async (kind: WorkEntityLink["kind"], name = "") => {
    if (!work.code || resolvingEntity) return;
    setResolvingEntity(kind);
    const entityKind = entityKindLabel(kind);
    toast.info(kind === "series" ? t("workCard.loadingSeries") : t("workCard.loadingEntity", { kind: entityKind }));
    try {
      const result = await api.resolveWorkEntityLink(work.code, kind, name);
      if (result.route) openEntityRoute(result.route);
    } catch (error) {
      toast.notify(toastFromError(error, t("workCard.couldNotOpenEntity", { kind: entityKind })));
    } finally {
      setResolvingEntity(null);
    }
  };
  const circleOpen = work.circleExternalId
    ? () =>
        onCircleOpen
          ? onCircleOpen(work.circleExternalId as string)
          : openEntityRoute(`/circles/${encodeURIComponent(work.circleExternalId as string)}`)
    : work.circle && work.circle !== "Unknown circle"
      ? () => void resolveEntity("circle", work.circle)
      : undefined;
  const seriesOpen = onSeriesOpen ?? (work.series ? () => void resolveEntity("series", work.series ?? "") : undefined);
  const voiceOpen = (name: string) => {
    const nameKey = name.trim().toLocaleLowerCase();
    const credit = work.voiceCredits?.find((item) => item.displayName.trim().toLocaleLowerCase() === nameKey);
    if (credit?.personId) {
      openEntityRoute(`/voices/${credit.personId}`);
      return;
    }
    if (onVoiceOpen) {
      onVoiceOpen(name);
      return;
    }
    void resolveEntity("voice", name);
  };
  const content = (
    <>
      <WorkCardMedia
        coverUrl={work.coverUrl}
        code={work.code}
        regularPrice={work.regularPrice ?? null}
        price={work.price ?? null}
        priceCurrency={work.priceCurrency}
        selection={selection}
        recommended={work.recommended}
        recommendationScore={work.recommendationScore}
        onRecommendationOpen={onRecommendationOpen}
      />
      <WorkCardBody
        work={work}
        onCircleOpen={circleOpen}
        onVoiceOpen={voiceOpen}
        onSeriesOpen={seriesOpen}
        onTagOpen={onTagOpen}
      />
    </>
  );

  return (
    <Card className="group h-full transition-colors hover:border-primary/50" data-testid="work-card">
      <CardContent className="flex h-full flex-col p-0">
        {onOpen ? (
          <div
            className={`flex flex-1 flex-col text-left ${canOpen ? "cursor-pointer" : "cursor-default"}`}
            role={canOpen ? "button" : undefined}
            tabIndex={canOpen ? 0 : undefined}
            onClick={canOpen ? onOpen : undefined}
            onKeyDown={
              canOpen
                ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen();
                    }
                  }
                : undefined
            }
          >
            {content}
          </div>
        ) : (
          <div className="flex flex-1 flex-col text-left">{content}</div>
        )}
        {footer}
      </CardContent>
    </Card>
  );
}

export function WorkCardMedia({
  coverUrl,
  code,
  regularPrice,
  price,
  priceCurrency,
  selection,
  recommended = false,
  recommendationScore,
  onRecommendationOpen,
}: {
  coverUrl?: string;
  code: string;
  regularPrice: number | null;
  price: number | null;
  priceCurrency?: string;
  selection?: ReactNode;
  recommended?: boolean;
  recommendationScore?: number;
  onRecommendationOpen?: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const codeText = code || t("workCard.source");
  return (
    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
      {selection}
      {coverUrl ? (
        <img
          src={assetURL(coverUrl)}
          alt=""
          className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
          loading="lazy"
        />
      ) : (
        <div className="grid h-full place-items-center bg-secondary text-2xl font-bold text-secondary-foreground">
          {codeText.slice(0, 2)}
        </div>
      )}
      <div className="absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold">
        {codeText}
      </div>
      {recommended &&
        (onRecommendationOpen ? (
          <button
            type="button"
            className="absolute right-3 top-3 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground shadow-sm"
            title={t("workCard.explainRecommendationScore")}
            aria-label={`${t("workCard.explainRecommendationScore")} ${recommendationScore ?? 0}`}
            onClick={(event) => {
              event.stopPropagation();
              onRecommendationOpen();
            }}
          >
            <Star className="h-4 w-4 fill-current" />
            {Number.isFinite(recommendationScore) && <span>{recommendationScore}</span>}
          </button>
        ) : (
          <div
            className="absolute right-3 top-3 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-2 text-xs font-semibold text-primary-foreground shadow-sm"
            title={t("workCard.recommendedForYou")}
            aria-label={t("workCard.recommendedForYou")}
          >
            <Star className="h-4 w-4 fill-current" />
            {Number.isFinite(recommendationScore) && <span>{recommendationScore}</span>}
          </div>
        ))}
      {price !== null && (
        <div
          className="absolute bottom-3 left-3 rounded-md bg-background/90 px-2 py-1 text-xs font-semibold"
          title={
            regularPrice !== null && regularPrice > price
              ? t("workCard.regularPrice", {
                  price: formatPrice(regularPrice, priceCurrency, resolvedLocale),
                })
              : undefined
          }
        >
          {price === 0 ? t("workCard.free") : formatPrice(price, priceCurrency, resolvedLocale)}
        </div>
      )}
    </div>
  );
}

function WorkCardBody({
  work,
  onCircleOpen,
  onVoiceOpen,
  onSeriesOpen,
  onTagOpen,
}: {
  work: WorkCardViewModel;
  onCircleOpen?: () => void;
  onVoiceOpen?: (name: string) => void;
  onSeriesOpen?: () => void;
  onTagOpen?: (tag: string) => void;
}) {
  const { t } = useTranslation();
  const ageRating = ageRatingPresentation(work.ageRating ?? "");
  const circleLabel = !work.circle || work.circle === "Unknown circle" ? t("workCard.unknownCircle") : work.circle;
  return (
    <div className="flex min-h-52 flex-1 flex-col gap-3 p-4">
      <div className="space-y-1">
        <h3 className="line-clamp-2 min-h-10 text-base font-semibold leading-snug">{work.title}</h3>
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-sm text-muted-foreground"
            title={[circleLabel, work.series].filter(Boolean).join(" / ")}
          >
            {onCircleOpen ? (
              <button
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
            {work.series && (
              <>
                <span aria-hidden="true"> / </span>
                {onSeriesOpen ? (
                  <button
                    className="font-medium text-foreground hover:text-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSeriesOpen();
                    }}
                  >
                    {work.series}
                  </button>
                ) : (
                  <span className="font-medium text-foreground">{work.series}</span>
                )}
              </>
            )}
          </div>
          {ageRating.known && (
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none",
                ageRating.badgeClassName,
              )}
            >
              {ageRating.label}
            </span>
          )}
        </div>
      </div>
      {work.voiceActors && work.voiceActors.length > 0 && (
        <div
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          title={work.voiceActors.join(", ")}
        >
          <MicVocal className="h-3.5 w-3.5 shrink-0" />
          <div className="min-w-0 truncate">
            {work.voiceActors.slice(0, 2).map((name, index) => (
              <span key={name}>
                {index > 0 && <span>, </span>}
                {onVoiceOpen ? (
                  <button
                    className="hover:text-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      onVoiceOpen(name);
                    }}
                  >
                    {name}
                  </button>
                ) : (
                  name
                )}
              </span>
            ))}
            {work.voiceActors.length > 2 && <VoiceOverflow names={work.voiceActors.slice(2)} onOpen={onVoiceOpen} />}
          </div>
        </div>
      )}
      <MeasuredBadgeList badges={work.dlsiteTags} emptyLabel={t("workCard.noDlsiteTags")} onBadgeClick={onTagOpen} />
      <WorkCardMetrics
        rating={work.rating ?? null}
        ratingCount={work.ratingCount ?? null}
        sales={work.sales ?? null}
        hasAvailableNonOriginEdition={work.hasAvailableNonOriginEdition === true}
        hasPlaybackHistory={work.hasPlaybackHistory === true}
      />
      {work.userTags && work.userTags.length > 0 && (
        <div className="flex min-h-6 flex-wrap gap-1.5">
          {work.userTags.map((tag) => {
            const badge = (
              <Badge
                variant={tag.variant ?? "secondary"}
                title={tag.title}
                className="border-primary/30 bg-primary/10 text-primary"
              >
                {tag.label}
              </Badge>
            );
            return tag.onClick ? (
              <button
                key={tag.key ?? tag.label}
                className="rounded-full hover:brightness-95"
                onClick={(event) => {
                  event.stopPropagation();
                  tag.onClick?.();
                }}
              >
                {badge}
              </button>
            ) : (
              <span key={tag.key ?? tag.label}>{badge}</span>
            );
          })}
        </div>
      )}
      <div className="mt-auto">
        <BadgeList badges={work.sourceBadges} emptyLabel={t("workCard.sourceUnavailable")} emptyVariant="warning" />
      </div>
    </div>
  );
}

function BadgeList({
  badges,
  emptyLabel,
  emptyVariant = "outline",
  onBadgeClick,
}: {
  badges: WorkCardBadge[];
  emptyLabel: string;
  emptyVariant?: WorkCardBadge["variant"];
  onBadgeClick?: (label: string) => void;
}) {
  return (
    <div className="flex min-h-6 flex-wrap gap-1.5">
      {badges.length > 0 ? (
        badges.map((badge) =>
          badge.onClick || onBadgeClick ? (
            <button
              key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
              onClick={(event) => {
                event.stopPropagation();
                (badge.onClick ?? (() => onBadgeClick?.(badge.label)))();
              }}
              className="rounded-full"
            >
              <Badge
                variant={badge.variant ?? "secondary"}
                title={badge.title}
                className="cursor-pointer hover:border-primary hover:text-primary"
              >
                {badge.label}
              </Badge>
            </button>
          ) : (
            <Badge
              key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
              variant={badge.variant ?? "secondary"}
              title={badge.title}
            >
              {badge.label}
            </Badge>
          ),
        )
      ) : (
        <Badge variant={emptyVariant}>{emptyLabel}</Badge>
      )}
    </div>
  );
}

function MeasuredBadgeList({
  badges,
  emptyLabel,
  onBadgeClick,
}: {
  badges: WorkCardBadge[];
  emptyLabel: string;
  onBadgeClick?: (label: string) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measurementRef = useRef<HTMLDivElement | null>(null);
  const overflowRef = useRef<HTMLButtonElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(badges.length);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const measurement = measurementRef.current;
    if (containerWidth <= 0 || !measurement) return;
    const widths = Array.from(measurement.querySelectorAll<HTMLElement>("[data-measured-badge]")).map(
      (element) => element.getBoundingClientRect().width,
    );
    const overflowWidth =
      measurement.querySelector<HTMLElement>("[data-measured-overflow]")?.getBoundingClientRect().width ?? 0;
    setVisibleCount(visibleBadgeCountForRows(widths, containerWidth, overflowWidth));
  }, [badges]);

  useLayoutEffect(() => {
    measure();
    const container = containerRef.current;
    const observer = typeof ResizeObserver === "undefined" || !container ? null : new ResizeObserver(measure);
    if (observer && container) observer.observe(container);
    window.addEventListener("resize", measure);
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    if (visibleCount >= badges.length) setOpen(false);
  }, [badges.length, visibleCount]);

  if (badges.length === 0) {
    return (
      <div className="flex min-h-6">
        <Badge variant="outline">{emptyLabel}</Badge>
      </div>
    );
  }

  const safeVisibleCount = Math.min(visibleCount, badges.length);
  const visibleBadges = badges.slice(0, safeVisibleCount);
  const hiddenBadges = badges.slice(safeVisibleCount);
  return (
    <div ref={containerRef} className="relative min-h-6 min-w-0" data-testid="work-card-tags">
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {visibleBadges.map((badge) => (
          <CardBadge
            key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
            badge={badge}
            onBadgeClick={onBadgeClick}
          />
        ))}
        {hiddenBadges.length > 0 && (
          <button
            ref={overflowRef}
            type="button"
            className="max-w-full rounded-full"
            aria-label={t("workCard.showMoreTags", { count: hiddenBadges.length })}
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((current) => !current);
            }}
          >
            <Badge variant="secondary" className="cursor-pointer hover:border-primary hover:text-primary">
              +{hiddenBadges.length}
            </Badge>
          </button>
        )}
      </div>
      <div
        ref={measurementRef}
        className="pointer-events-none invisible absolute inset-x-0 top-0 -z-10 flex flex-col items-start"
        aria-hidden="true"
      >
        {badges.map((badge) => (
          <Badge
            key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
            data-measured-badge
            variant={badge.variant ?? "secondary"}
            className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {badge.label}
          </Badge>
        ))}
        <Badge data-measured-overflow variant="secondary">
          +{badges.length}
        </Badge>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={overflowRef}
        onOpenChange={setOpen}
        bottomCollisionPadding={isMobileViewport() ? 168 : 12}
        className="w-[min(20rem,calc(100vw-1.5rem))] p-2"
      >
        <div className="flex flex-wrap gap-1.5">
          {hiddenBadges.map((badge) => (
            <CardBadge
              key={badge.key ?? `${badge.label}:${badge.variant ?? "secondary"}`}
              badge={badge}
              onBadgeClick={onBadgeClick}
              onSelected={() => setOpen(false)}
            />
          ))}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function CardBadge({
  badge,
  onBadgeClick,
  onSelected,
}: {
  badge: WorkCardBadge;
  onBadgeClick?: (label: string) => void;
  onSelected?: () => void;
}) {
  const badgeElement = (
    <Badge
      variant={badge.variant ?? "secondary"}
      title={badge.title}
      className={cn(
        "max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
        (badge.onClick || onBadgeClick) && "cursor-pointer hover:border-primary hover:text-primary",
      )}
    >
      {badge.label}
    </Badge>
  );
  return badge.onClick || onBadgeClick ? (
    <button
      type="button"
      className="max-w-full rounded-full"
      onClick={(event) => {
        event.stopPropagation();
        (badge.onClick ?? (() => onBadgeClick?.(badge.label)))();
        onSelected?.();
      }}
    >
      {badgeElement}
    </button>
  ) : (
    <span className="max-w-full">{badgeElement}</span>
  );
}

function WorkCardMetrics({
  rating,
  ratingCount,
  sales,
  hasAvailableNonOriginEdition,
  hasPlaybackHistory,
}: {
  rating: number | null;
  ratingCount: number | null;
  sales: number | null;
  hasAvailableNonOriginEdition: boolean;
  hasPlaybackHistory: boolean;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const normalizedRating = rating !== null && Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : null;
  const normalizedRatingCount =
    ratingCount !== null && Number.isFinite(ratingCount) && ratingCount >= 0 ? Math.floor(ratingCount) : null;
  const ratingLabel =
    normalizedRating === null
      ? t("workCard.noRating")
      : normalizedRatingCount === null
        ? t("workCard.rating", { value: formatRating(normalizedRating, resolvedLocale) })
        : t("workCard.ratingWithCount", {
            value: formatRating(normalizedRating, resolvedLocale),
            count: formatStandardCount(normalizedRatingCount, resolvedLocale),
          });
  const salesLabel =
    sales !== null && Number.isFinite(sales) && sales >= 0
      ? t("workCard.salesLabel", { value: formatStandardCount(Math.floor(sales), resolvedLocale) })
      : t("workCard.salesUnavailable");
  return (
    <div className="flex min-h-10 min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <span
          className="inline-flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
          title={salesLabel}
          aria-label={salesLabel}
        >
          <ShoppingBag className="h-3.5 w-3.5 shrink-0" />
          <span className="shrink-0 font-medium">{t("workCard.sales")}</span>
          <span className="min-w-0 truncate tabular-nums text-foreground">
            {formatCompactCount(sales, resolvedLocale)}
          </span>
        </span>
        <span
          className="inline-flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
          title={ratingLabel}
          role="img"
          aria-label={ratingLabel}
        >
          <span className="shrink-0 font-medium">{t("workCard.ratingShort")}</span>
          <span className="flex w-8 shrink-0 items-center gap-0.5" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => {
              const fill = normalizedRating === null ? 0 : Math.min(1, Math.max(0, normalizedRating - index));
              return (
                <span key={index} className="h-1.5 w-1.5 flex-1 overflow-hidden rounded-[2px] bg-muted">
                  <span className="block h-full bg-primary" style={{ width: `${fill * 100}%` }} />
                </span>
              );
            })}
          </span>
          <span className="shrink-0 tabular-nums text-foreground">
            {normalizedRating === null ? "--" : formatRating(normalizedRating, resolvedLocale)}
          </span>
          {normalizedRatingCount !== null && (
            <span className="min-w-0 truncate tabular-nums">
              ({formatCompactCount(normalizedRatingCount, resolvedLocale)})
            </span>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {hasAvailableNonOriginEdition && (
          <span
            className="inline-flex shrink-0 text-primary"
            title={t("workCard.otherLanguageEdition")}
            role="img"
            aria-label={t("workCard.otherLanguageEdition")}
          >
            <Languages className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        {hasPlaybackHistory && (
          <span
            className="inline-flex shrink-0 text-muted-foreground"
            title={t("workCard.playbackHistory")}
            role="img"
            aria-label={t("workCard.playbackHistory")}
          >
            <History className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
      </div>
    </div>
  );
}

function formatPrice(value: number, currency: string | undefined, locale: ResolvedUiLocale) {
  try {
    return new Intl.NumberFormat(intlLocaleFor(locale), {
      style: "currency",
      currency: currency || "JPY",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${formatStandardCount(value, locale)} ${currency || "JPY"}`;
  }
}

function formatRating(value: number, locale: ResolvedUiLocale) {
  return new Intl.NumberFormat(intlLocaleFor(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatStandardCount(value: number, locale: ResolvedUiLocale) {
  return new Intl.NumberFormat(intlLocaleFor(locale)).format(value);
}

function formatCompactCount(value: number | null, locale: ResolvedUiLocale) {
  if (value === null || !Number.isFinite(value) || value < 0) return "--";
  return new Intl.NumberFormat(intlLocaleFor(locale), {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(Math.floor(value));
}

export function WorkCardFooter({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-auto flex h-11 shrink-0 items-center justify-between gap-1 border-t px-3">
      <div className="flex min-w-0 items-center gap-1">{left}</div>
      <div className="flex min-w-0 items-center gap-1">{right}</div>
    </div>
  );
}

export function WorkCardActionButton({
  title,
  disabled,
  showLabel = false,
  responsiveLabel = false,
  label,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  showLabel?: boolean;
  responsiveLabel?: boolean;
  label?: string;
  children: ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button
      variant={showLabel ? "outline" : "ghost"}
      size={showLabel ? "sm" : "icon"}
      className={showLabel ? (responsiveLabel ? "h-8 w-8 px-0 sm:w-auto sm:px-3" : "h-8") : "h-8 w-8"}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {showLabel && <span className={responsiveLabel ? "hidden sm:inline" : undefined}>{label ?? title}</span>}
    </Button>
  );
}

export function WorkCardQuickMarkButton({
  value,
  disabled,
  showLabel = false,
  responsiveLabel = false,
  onChange,
}: {
  value: ListeningStatus;
  disabled?: boolean;
  showLabel?: boolean;
  responsiveLabel?: boolean;
  onChange: (status: ListeningStatus) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const current = quickMarkMeta(value);
  const currentLabel = t(listeningStatusKey(value));
  const bottomCollisionPadding = isMobileViewport() ? 168 : 12;

  return (
    <div className="relative" ref={ref}>
      <WorkCardActionButton
        title={t("workCard.mark", { status: currentLabel })}
        disabled={disabled}
        showLabel={showLabel}
        responsiveLabel={responsiveLabel}
        label={t("workCard.mark", { status: currentLabel })}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <current.icon className={`h-4 w-4 ${current.active ? current.className : "text-muted-foreground"}`} />
      </WorkCardActionButton>
      <AnchoredPopover
        open={open}
        anchorRef={ref}
        onOpenChange={setOpen}
        bottomCollisionPadding={bottomCollisionPadding}
        className="w-40 p-1 text-sm"
      >
        {quickMarkOptions.map((option) => {
          const meta = quickMarkMeta(option);
          const selected = option === value;
          return (
            <button
              key={option}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted",
                selected && "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15",
              )}
              aria-pressed={selected}
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onChange(option);
              }}
            >
              <meta.icon className={`h-3.5 w-3.5 ${selected && meta.active ? meta.className : ""}`} />
              <span className="min-w-0 flex-1">{t(listeningStatusKey(option))}</span>
            </button>
          );
        })}
      </AnchoredPopover>
    </div>
  );
}

export function WorkCardListButton({
  workId,
  active,
  disabled,
  showLabel = false,
  responsiveLabel = false,
  ensureWorkId,
  onSaved,
}: {
  workId: number | null;
  active: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  responsiveLabel?: boolean;
  ensureWorkId?: () => Promise<number | null>;
  onSaved?: (favorite: boolean, workId: number) => void;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [resolvedWorkId, setResolvedWorkId] = useState<number | null>(null);
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const effectiveWorkId = workId ?? resolvedWorkId;
  const bottomCollisionPadding = isMobileViewport() ? 168 : 12;

  useEffect(() => {
    if (!open || !effectiveWorkId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([api.listFavoriteLists(), api.getWorkFavoriteLists(effectiveWorkId)])
      .then(([allLists, workLists]) => {
        if (cancelled) return;
        setLists(allLists.filter((list) => list.kind !== "marked"));
        setSelected(
          new Set(workLists.filter((list) => list.kind !== "marked" && list.selected).map((list) => list.id)),
        );
      })
      .catch((nextError) => {
        if (!cancelled) {
          const fallback = t("workCard.favoriteListsLoadFailed");
          toast.notify(toastFromError(nextError, fallback));
          setError(nextError instanceof Error ? nextError.message : fallback);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveWorkId, open, t, toast]);

  const toggle = (listID: number, checked: boolean) => {
    setSelected((items) => {
      const next = new Set(items);
      if (checked) next.add(listID);
      else next.delete(listID);
      return next;
    });
  };

  const save = async () => {
    if (!effectiveWorkId) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.setWorkFavoriteLists(effectiveWorkId, Array.from(selected));
      onSaved?.(result.favorite, effectiveWorkId);
      setOpen(false);
    } catch (nextError) {
      const fallback = t("workCard.favoriteListsSaveFailed");
      toast.notify(toastFromError(nextError, fallback));
      setError(nextError instanceof Error ? nextError.message : fallback);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <WorkCardActionButton
        title={active ? t("workCard.favoriteLists") : t("workCard.addToList")}
        disabled={disabled || resolving || (!effectiveWorkId && !ensureWorkId)}
        showLabel={showLabel}
        responsiveLabel={responsiveLabel}
        label={active ? t("workCard.lists") : t("workCard.addList")}
        onClick={(event) => {
          event.stopPropagation();
          if (effectiveWorkId) {
            setOpen((value) => !value);
            return;
          }
          if (!ensureWorkId) return;
          setResolving(true);
          setError("");
          ensureWorkId()
            .then((nextWorkId) => {
              if (!nextWorkId) return;
              setResolvedWorkId(nextWorkId);
              setOpen(true);
            })
            .catch((nextError) => {
              const fallback = t("workCard.workTrackFailed");
              toast.notify(toastFromError(nextError, fallback));
              setError(nextError instanceof Error ? nextError.message : fallback);
            })
            .finally(() => setResolving(false));
        }}
      >
        <ListMusic className={`h-4 w-4 ${active ? "fill-current text-primary" : "text-muted-foreground"}`} />
      </WorkCardActionButton>
      <AnchoredPopover
        open={open}
        anchorRef={ref}
        onOpenChange={setOpen}
        bottomCollisionPadding={bottomCollisionPadding}
        className="w-56 p-2 text-left"
      >
        <div className="text-sm font-semibold">{t("workCard.lists")}</div>
        <div className="app-scroll mt-2 max-h-56 space-y-1.5 overflow-auto">
          {loading ? (
            <div className="rounded-md border bg-background px-2.5 py-2 text-sm text-muted-foreground">
              {t("workCard.loadingLists")}
            </div>
          ) : lists.length > 0 ? (
            lists.map((list) => (
              <div
                key={list.id}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-2 rounded-md border bg-background px-2.5 text-sm hover:bg-muted",
                  selected.has(list.id) && "border-primary/30 bg-primary/10",
                )}
                onClick={() => toggle(list.id, !selected.has(list.id))}
              >
                <Checkbox
                  checked={selected.has(list.id)}
                  onCheckedChange={(checked) => toggle(list.id, checked)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={t(selected.has(list.id) ? "workCard.removeFromList" : "workCard.addToNamedList", {
                    name: list.name,
                  })}
                />
                <span className="min-w-0 flex-1 truncate">{list.name}</span>
              </div>
            ))
          ) : (
            <div className="rounded-md border bg-background px-2.5 py-2 text-sm text-muted-foreground">
              {t("workCard.noLists")}
            </div>
          )}
          {error && (
            <div className="rounded-md border bg-background px-2.5 py-2 text-xs text-muted-foreground">{error}</div>
          )}
        </div>
        <div className="mt-2 flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("workCard.cancel")}
            aria-label={t("workCard.cancel")}
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            className="h-8 w-8"
            title={saving ? t("workCard.saving") : t("workCard.save")}
            aria-label={saving ? t("workCard.saving") : t("workCard.save")}
            disabled={loading || saving}
            onClick={() => void save()}
          >
            <Check className="h-4 w-4" />
          </Button>
        </div>
      </AnchoredPopover>
    </div>
  );
}

export function WorkCardDLsiteAction({ href }: { href: string }) {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="icon" className="h-8 w-8" asChild title={t("workCard.openDLsite")}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        aria-label={t("workCard.openDLsite")}
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </Button>
  );
}

export function WorkCardSelection({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "absolute right-0.5 top-0.5 z-10 grid h-11 w-11 place-items-center bg-transparent",
        disabled ? "cursor-default" : "cursor-pointer",
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        onClick={(event) => event.stopPropagation()}
        className="shadow-sm"
        aria-label={t("workCard.selectWork")}
      />
    </div>
  );
}

export function dlsiteTagBadges(tags: string[]): WorkCardBadge[] {
  return tags.map((tag) => ({ key: `dlsite:${tag}`, label: tag, variant: "outline" }));
}

export function userTagBadges(tags: UserTag[], onOpen?: (tag: string) => void): WorkCardBadge[] {
  return tags.map((tag) => ({
    key: `user:${tag.id}`,
    label: tag.name,
    title: i18n.t("workCard.myTag", { name: tag.name }),
    variant: "secondary",
    onClick: onOpen ? () => onOpen(tag.name) : undefined,
  }));
}

const quickMarkOptions: ListeningStatus[] = ["none", "want_to_listen", "listening", "finished", "relisten", "paused"];

function quickMarkMeta(value: ListeningStatus) {
  switch (value) {
    case "want_to_listen":
      return { icon: BookmarkPlus, active: true, className: "text-primary" };
    case "listening":
      return { icon: Headphones, active: true, className: "text-primary" };
    case "finished":
      return { icon: CheckCircle2, active: true, className: "text-success" };
    case "relisten":
      return { icon: Repeat2, active: true, className: "text-primary" };
    case "paused":
      return { icon: PauseCircle, active: true, className: "text-warning" };
    default:
      return { icon: Circle, active: false, className: "" };
  }
}

function listeningStatusKey(value: ListeningStatus) {
  return `workCard.status.${value}` as const;
}

function VoiceOverflow({ names, onOpen }: { names: string[]; onOpen?: (name: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={anchorRef}
        className="ml-1 hover:text-primary"
        aria-label={t("workCard.showMoreVoiceActors", { count: names.length })}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        +{names.length}
      </button>
      <AnchoredPopover open={open} anchorRef={anchorRef} onOpenChange={setOpen} className="w-56 p-2">
        <div className="flex flex-col gap-1">
          {names.map((name) =>
            onOpen ? (
              <button
                key={name}
                className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted hover:text-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onOpen(name);
                }}
              >
                {name}
              </button>
            ) : (
              <div key={name} className="px-2 py-1.5 text-sm">
                {name}
              </div>
            ),
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

function entityKindLabel(kind: WorkEntityLink["kind"]) {
  switch (kind) {
    case "series":
      return i18n.t("workCard.entityKinds.series");
    case "voice":
      return i18n.t("workCard.entityKinds.voice");
    default:
      return i18n.t("workCard.entityKinds.circle");
  }
}

function openEntityRoute(route: string) {
  if (!route.startsWith("/")) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.history.pushState(historyStateWithReturn(returnTo, i18n.t("workCard.back")), "", route);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
}

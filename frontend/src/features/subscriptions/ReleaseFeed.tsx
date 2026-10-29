import { Loader2, Rss } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { LayoutWorkCard, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkCardActionFooter } from "@/components/work-card/WorkCardActionFooter";
import {
  WorkCardContextItem,
  WorkCardContextStrip,
  WorkCardStatusBadge,
  WorkCardUnreadDot,
} from "@/components/work-card/WorkCardContext";
import { dlsiteTagBadges, userTagBadges, type WorkCardViewModel } from "@/components/work-card/WorkCardShell";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { WorkSectionHeading } from "@/components/work-collection/WorkSectionHeading";
import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type ReleaseFeedFamily, type ReleaseFeedPage, type Work } from "@/lib/api";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { shownWorkSourcePresence, type ShownWorksSourceCheck } from "@/lib/shownWorksSourceCheck";

import {
  groupReleaseFeedByDay,
  primaryReleaseEvent,
  RELEASE_FEED_SEEN_EVENT,
  releaseEventLabel,
  releaseFeedSources,
  type ReleaseFeedDay,
} from "./subscriptionModel";

/**
 * The card of a family. Its source badges follow what the work records and
 * this visit's source checks; a catalog-only family shows no "no source"
 * badge.
 */
function releaseFeedCardView(
  family: ReleaseFeedFamily,
  unknownCircle: string,
  check: ShownWorksSourceCheck,
): WorkCardViewModel {
  const work = family.work;
  const presence = shownWorkSourcePresence({ code: releaseFeedCode(family), work }, check);
  if (work) {
    return {
      code: work.primaryCode,
      title: work.title,
      titleSource: work.titleSource,
      circle: work.circle || unknownCircle,
      circleExternalId: work.circleExternalId,
      ageRating: work.ageRating,
      voiceActors: work.voiceActors,
      voiceCredits: work.voiceCredits,
      coverUrl: work.coverUrl,
      rating: work.rating,
      ratingCount: work.ratingCount,
      sales: work.sales,
      regularPrice: work.regularPrice,
      price: work.price,
      priceCurrency: work.priceCurrency,
      series: work.series || null,
      hasLyrics: work.hasLyrics,
      dlsiteTags: dlsiteTagBadges(work.tags),
      userTags: userTagBadges(work.userTags ?? []),
      sourceBadges: sourcePresenceBadges(presence, work.availability),
      sourceBadgeStyle: "icon",
    };
  }
  const fallback = family.fallback;
  return {
    code: fallback.code,
    title: fallback.title || fallback.code,
    circle: fallback.circle || unknownCircle,
    voiceActors: fallback.voiceActors,
    coverUrl: fallback.coverUrl,
    dlsiteTags: dlsiteTagBadges(fallback.tags),
    sourceBadges: sourcePresenceBadges(presence).filter((badge) => badge.key !== "source:no-source"),
    sourceBadgeStyle: "icon",
    sourceUnavailableFallback: false,
  };
}

/** The code a family's card shows and acts on: its work's, or the catalog's. */
function releaseFeedCode(family: ReleaseFeedFamily) {
  return family.work?.primaryCode ?? family.fallback.code;
}

/**
 * New works from the account's subscriptions and Availability Watch, one card
 * per work family, grouped by the day of the family's newest event. A page
 * holds a number of days that have entries.
 */
export function ReleaseFeed({
  page,
  days,
  cardLayout,
  mobileColumns,
  desktopColumns,
  canMarkSeen,
  canMark,
  canWatch,
  availableActions,
  sourceCheck,
  reloadKey,
  onOpenWork,
  onPageChange,
  onLoaded,
}: {
  page: number;
  days: number;
  /** The reduced card layout, or null for the regular card. */
  cardLayout: CompactWorkCardLayout | null;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  /** Opening the feed records it as read; Demo keeps its sample state. */
  canMarkSeen: boolean;
  /** The account may add library works to lists, rate, and mark them. */
  canMark: boolean;
  /** The account may add works to Availability Watch. */
  canWatch: boolean;
  /** Track and Fetch for a family whose "Now available" event names an available watch target. */
  availableActions?: (target: NonNullable<ReleaseFeedFamily["watchTarget"]>) => ReactNode;
  /** What this visit's source checks found for the shown works. */
  sourceCheck: ShownWorksSourceCheck;
  /** Changes when the feed should be read again, such as after a run on its works. */
  reloadKey: number;
  onOpenWork: (code: string) => void;
  onPageChange: (page: number) => void;
  onLoaded?: (page: ReleaseFeedPage) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const [feed, setFeed] = useState<ReleaseFeedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [watched, setWatched] = useState<Set<string>>(() => new Set());
  const [watching, setWatching] = useState<Set<string>>(() => new Set());
  const markedSeen = useRef(false);
  const latestOnLoaded = useRef(onLoaded);
  latestOnLoaded.current = onLoaded;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const next = await api.getReleaseFeed(page, days, signal);
        setFeed(next);
        latestOnLoaded.current?.(next);
        if (canMarkSeen && !next.demo && !markedSeen.current && next.unreadCount > 0) {
          markedSeen.current = true;
          await api.markReleaseFeedSeen();
          window.dispatchEvent(new Event(RELEASE_FEED_SEEN_EVENT));
        }
      } catch (loadError) {
        if (!signal?.aborted)
          setError(loadError instanceof Error ? loadError.message : t("subscriptions.feed.loadFailed"));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [canMarkSeen, days, page, t],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // A new reloadKey reads the feed again.
  }, [load, reloadKey]);

  // A page past the end, after fewer days per page or an emptied feed, shows the last one.
  const totalPages = feed ? Math.max(1, Math.ceil(feed.totalDays / Math.max(1, feed.days))) : 1;
  useEffect(() => {
    if (feed && !loading && page > totalPages) onPageChange(totalPages);
  }, [feed, loading, onPageChange, page, totalPages]);

  const patchWork = (workId: number, patch: Partial<Work>) =>
    setFeed(
      (current) =>
        current && {
          ...current,
          families: current.families.map((family) =>
            family.work?.id === workId ? { ...family, work: { ...family.work, ...patch } } : family,
          ),
        },
    );

  const watch = async (code: string) => {
    setWatching((current) => new Set(current).add(code));
    try {
      await api.addAvailabilityWatchTargets([code]);
      setWatched((current) => new Set(current).add(code));
      toast.success(t("subscriptions.feed.watchAdded", { code }));
    } catch (watchError) {
      toast.notify(toastFromError(watchError, t("subscriptions.feed.watchFailed")));
    } finally {
      setWatching((current) => {
        const next = new Set(current);
        next.delete(code);
        return next;
      });
    }
  };

  if (loading && !feed) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("subscriptions.feed.loading")}
      </div>
    );
  }
  if (error && !feed) {
    return (
      <div className="space-y-3 rounded-lg border border-error-border bg-error-surface p-4 text-sm" role="alert">
        <p className="text-error-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (!feed || feed.families.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <Rss className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">{t("subscriptions.feed.empty")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("subscriptions.feed.emptyDescription")}</p>
      </div>
    );
  }

  const demo = feed.demo;
  const dayFormat = dateTimeFormat(resolvedLocale, { month: "long", day: "numeric", weekday: "short" });
  const yearDayFormat = dateTimeFormat(resolvedLocale, { year: "numeric", month: "long", day: "numeric" });
  const thisYear = Number(feed.today.slice(0, 4));
  const dayLabel = (group: ReleaseFeedDay) => {
    if (group.offset === 0) return t("subscriptions.feed.today");
    if (group.offset === 1) return t("subscriptions.feed.yesterday");
    if (!group.date) return group.day;
    return (group.date.getFullYear() === thisYear ? dayFormat : yearDayFormat).format(group.date);
  };

  const card = (family: ReleaseFeedFamily) => {
    const event = primaryReleaseEvent(family);
    const code = releaseFeedCode(family);
    return (
      <LayoutWorkCard
        layout={cardLayout}
        work={releaseFeedCardView(family, t("workCard.unknownCircle"), sourceCheck)}
        canOpen={!demo}
        onOpen={() => onOpenWork(code)}
        onCircleOpen={demo ? undefined : (externalId: string) => openCircleRoute(externalId)}
        footer={
          demo ? undefined : (
            <WorkCardActionFooter
              layout={cardLayout}
              dlsiteUrl={family.work?.dlsiteUrl || family.fallback.dlsiteUrl}
              watch={
                canWatch && event?.type !== "available"
                  ? {
                      watched: family.watched || watched.has(code),
                      pending: watching.has(code),
                      onWatch: () => void watch(code),
                    }
                  : null
              }
              actions={family.watchTarget && availableActions?.(family.watchTarget)}
              work={family.work}
              canMark={canMark}
              onWorkChange={patchWork}
            />
          )
        }
      />
    );
  };

  return (
    <div className="space-y-6" aria-busy={loading}>
      {groupReleaseFeedByDay(feed.families, feed.today).map((group) => {
        const label = dayLabel(group);
        return (
          <section key={group.day} aria-label={t("subscriptions.feed.dayLabel", { day: label })}>
            <WorkSectionHeading
              title={label}
              detail={
                group.offset !== null && group.offset <= 1 && group.date ? dayFormat.format(group.date) : undefined
              }
              count={group.families.length}
              countLabel={t("subscriptions.feed.dayCount", { count: group.families.length })}
            />
            <ol
              className={workCollectionClassName()}
              style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
            >
              {group.families.map((family) => (
                <WorkCardContextItem
                  key={family.key}
                  label={releaseFeedTitle(family)}
                  context={<ReleaseFeedContext family={family} />}
                >
                  {card(family)}
                </WorkCardContextItem>
              ))}
            </ol>
          </section>
        );
      })}
      <WorkCollectionPagination
        placement="bottom"
        page={page}
        pageSize={feed.days}
        totalItems={feed.total}
        totalPages={totalPages}
        onPageChange={onPageChange}
      />
    </div>
  );
}

function releaseFeedTitle(family: ReleaseFeedFamily) {
  return family.work?.title || family.fallback.title || family.fallback.code;
}

/** What happened to a family and through which subscription, above its card. */
function ReleaseFeedContext({ family }: { family: ReleaseFeedFamily }) {
  const { t } = useTranslation();
  const event = primaryReleaseEvent(family);
  return (
    <WorkCardContextStrip detail={releaseFeedSources(family, t).join(" · ")}>
      {family.unread && <WorkCardUnreadDot label={t("subscriptions.feed.unread")} />}
      {event && (
        <WorkCardStatusBadge tone={event.type === "available" ? "success" : "neutral"}>
          {releaseEventLabel(event, t)}
        </WorkCardStatusBadge>
      )}
    </WorkCardContextStrip>
  );
}

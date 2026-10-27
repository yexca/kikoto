import { Loader2, Rss } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { CompactWorkCardShell, type CompactWorkCardLayout } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkCardWatchButton } from "@/components/work-card/WorkCardWatchButton";
import {
  dlsiteTagBadges,
  userTagBadges,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardShell,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkCollectionPagination } from "@/components/work-collection/WorkCollectionPagination";
import { dateTimeFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type ReleaseFeedFamily, type ReleaseFeedPage } from "@/lib/api";
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
  canWatch,
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
  /** The account may add works to Availability Watch. */
  canWatch: boolean;
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
    const view = releaseFeedCardView(family, t("workCard.unknownCircle"), sourceCheck);
    const code = releaseFeedCode(family);
    const footer = demo ? undefined : (
      <WorkCardFooter
        className={cardLayout === "row" ? "h-10 border-border/40" : undefined}
        left={<WorkCardDLsiteAction href={family.work?.dlsiteUrl || family.fallback.dlsiteUrl} />}
        right={
          <>
            {canWatch && event?.type !== "available" && (
              <WorkCardWatchButton
                watched={family.watched || watched.has(code)}
                pending={watching.has(code)}
                onWatch={() => void watch(code)}
              />
            )}
            {family.work && (
              <WorkCardListButton
                workId={family.work.id}
                active={family.work.favorite}
                memberLists={family.work.memberLists}
                fitLabel
              />
            )}
          </>
        }
      />
    );
    const shared = {
      work: view,
      canOpen: !demo,
      onOpen: () => onOpenWork(code),
      onCircleOpen: demo ? undefined : (externalId: string) => openCircleRoute(externalId),
      footer,
    };
    return cardLayout ? <CompactWorkCardShell layout={cardLayout} {...shared} /> : <WorkCardShell {...shared} />;
  };

  return (
    <div className="space-y-6" aria-busy={loading}>
      {groupReleaseFeedByDay(feed.families, feed.today).map((group) => {
        const label = dayLabel(group);
        return (
          <section key={group.day} aria-label={t("subscriptions.feed.dayLabel", { day: label })}>
            <div className="mb-3 flex items-center gap-3">
              <h3 className="flex min-w-0 shrink-0 items-baseline gap-2">
                <span className="text-lg font-semibold leading-7">{label}</span>
                {group.offset !== null && group.offset <= 1 && group.date && (
                  <span className="text-sm text-muted-foreground">{dayFormat.format(group.date)}</span>
                )}
              </h3>
              <Badge variant="outline" className="shrink-0 tabular-nums">
                {t("subscriptions.feed.dayCount", { count: group.families.length })}
              </Badge>
              <span className="h-px min-w-4 flex-1 bg-border" aria-hidden="true" />
            </div>
            <ol
              className={workCollectionClassName()}
              style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
            >
              {group.families.map((family) => (
                <ReleaseFeedItem key={family.key} family={family} title={releaseFeedTitle(family)}>
                  {card(family)}
                </ReleaseFeedItem>
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

/** One family: what happened and through which subscription, above its card. */
function ReleaseFeedItem({
  family,
  title,
  children,
}: {
  family: ReleaseFeedFamily;
  title: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const event = primaryReleaseEvent(family);
  const sources = releaseFeedSources(family, t).join(" · ");
  return (
    <li aria-label={title} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
        {family.unread && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" title={t("subscriptions.feed.unread")}>
            <span className="sr-only">{t("subscriptions.feed.unread")}</span>
          </span>
        )}
        {event && (
          <Badge variant={event.type === "available" ? "success" : "secondary"} className="shrink-0">
            {releaseEventLabel(event, t)}
          </Badge>
        )}
        <span className="min-w-0 truncate text-muted-foreground" title={sources}>
          {sources}
        </span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </li>
  );
}

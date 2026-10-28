import { Compass, Repeat, Shuffle, Sparkles, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { CompactWorkCardShell, CompactWorkCardSkeleton } from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkRatingControl } from "@/components/work-card/WorkRatingControl";
import {
  dlsiteTagBadges,
  formatRating,
  userTagBadges,
  WorkCardDLsiteAction,
  WorkCardFooter,
  WorkCardListButton,
  WorkCardQuickMarkButton,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type ListeningStatus, type Work } from "@/lib/api";
import { FOR_YOU_COLUMNS, FOR_YOU_TEMPERATURES, type ForYouColumn, type ForYouItem } from "@/lib/forYouApi";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { cn } from "@/lib/tailwindClassNames";

import { forYouReasonText, type ForYouColumnState } from "./forYouModel";
import { useForYou } from "./useForYou";

const COLUMN_ICONS: Record<ForYouColumn, LucideIcon> = {
  maybe_like: Sparkles,
  try_new: Compass,
  listen_again: Repeat,
};

/**
 * For you: three small draws from the local library, Maybe like, Try new,
 * and Listen again, under one temperature. Wide views show the columns side
 * by side; narrower ones switch between them. Cards offer the Library's own
 * actions, and opening one records an open so later draws rotate.
 */
export function ForYouView({ canMark, onOpenWork }: { canMark: boolean; onOpenWork: (code: string) => void }) {
  const { t } = useTranslation();
  const forYou = useForYou(true);
  const [shown, setShown] = useState<ForYouColumn>("maybe_like");
  const coldStart = FOR_YOU_COLUMNS.some((column) => forYou.columns[column].coldStart);

  const open = (column: ForYouColumn, item: ForYouItem, rank: number) => {
    void api
      .recordRecommendationEvents([
        {
          workId: item.work.id,
          eventType: "open",
          contextId: column,
          algorithmVersion: forYou.algorithmVersion,
          rank,
          score: item.score,
          surface: "for_you",
        },
      ])
      .catch(() => undefined);
    onOpenWork(item.work.primaryCode);
  };

  return (
    <section className="@container min-w-0 space-y-4" aria-label={t("subscriptions.forYou.label")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="radiogroup"
          aria-label={t("subscriptions.forYou.temperature.label")}
          className={segmentedListClassName()}
        >
          {FOR_YOU_TEMPERATURES.map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={forYou.temperature === item}
              className={segmentedItemClassName(forYou.temperature === item)}
              disabled={forYou.temperature === null}
              onClick={() => forYou.temperature !== item && void forYou.changeTemperature(item)}
            >
              {t(`subscriptions.forYou.temperature.${item}`)}
            </button>
          ))}
        </div>
        {forYou.temperature && (
          <p className="min-w-0 text-xs text-muted-foreground">
            {t(`subscriptions.forYou.temperature.hints.${forYou.temperature}`)}
          </p>
        )}
      </div>
      {forYou.status === "failed" || forYou.status === "preparing" ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-10 text-center text-sm">
          <p className="text-muted-foreground">
            {forYou.status === "preparing" ? t("subscriptions.forYou.preparing") : t("subscriptions.forYou.failed")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void forYou.drawAll()}>
            {t("common.retry")}
          </Button>
        </div>
      ) : (
        <>
          {coldStart && (
            <p className="rounded-lg border border-info-border bg-info-surface px-3 py-2 text-xs text-info-foreground">
              {t("subscriptions.forYou.coldStart")}
            </p>
          )}
          {/* Below the three-column width one column shows at a time. */}
          <div
            role="tablist"
            aria-label={t("subscriptions.forYou.columnsLabel")}
            className={segmentedListClassName("@5xl:hidden")}
          >
            {FOR_YOU_COLUMNS.map((column) => {
              const Icon = COLUMN_ICONS[column];
              return (
                <button
                  key={column}
                  type="button"
                  role="tab"
                  aria-selected={shown === column}
                  aria-controls={`for-you-${column}`}
                  className={segmentedItemClassName(shown === column)}
                  onClick={() => setShown(column)}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(`subscriptions.forYou.columns.${column}`)}
                </button>
              );
            })}
          </div>
          <div className="grid items-start gap-4 @5xl:grid-cols-3 @5xl:gap-5">
            {FOR_YOU_COLUMNS.map((column) => (
              <ForYouColumnSection
                key={column}
                column={column}
                state={forYou.columns[column]}
                className={shown === column ? undefined : "hidden @5xl:block"}
                canMark={canMark}
                onDrawAgain={() => void forYou.drawColumn(column)}
                onOpen={(item, rank) => open(column, item, rank)}
                onPatch={forYou.patchWork}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ForYouColumnSection({
  column,
  state,
  className,
  canMark,
  onDrawAgain,
  onOpen,
  onPatch,
}: {
  column: ForYouColumn;
  state: ForYouColumnState;
  className?: string;
  canMark: boolean;
  onDrawAgain: () => void;
  onOpen: (item: ForYouItem, rank: number) => void;
  onPatch: (workId: number, patch: Partial<Work>) => void;
}) {
  const { t } = useTranslation();
  const Icon = COLUMN_ICONS[column];
  const title = t(`subscriptions.forYou.columns.${column}`);
  const headingId = `for-you-${column}-heading`;
  const loading = state.drawing && state.items.length === 0;
  return (
    <section id={`for-you-${column}`} aria-labelledby={headingId} className={cn("min-w-0 space-y-3", className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-1.5 text-base font-semibold">
            <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{t(`subscriptions.forYou.descriptions.${column}`)}</p>
        </div>
        <Button
          variant="toolbar"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={state.drawing}
          aria-label={t("subscriptions.forYou.drawAgainColumn", { column: title })}
          title={t("subscriptions.forYou.drawAgainColumn", { column: title })}
          onClick={onDrawAgain}
        >
          <Shuffle className={cn("h-3.5 w-3.5", state.drawing && "animate-pulse")} aria-hidden="true" />
          {t("subscriptions.forYou.drawAgain")}
        </Button>
      </div>
      {loading ? (
        <div className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-1" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <CompactWorkCardSkeleton key={index} layout="row" />
          ))}
        </div>
      ) : state.failed && state.items.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground">
          {t("subscriptions.forYou.columnFailed")}
          <Button variant="outline" size="sm" onClick={onDrawAgain}>
            {t("common.retry")}
          </Button>
        </div>
      ) : state.items.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-sm text-muted-foreground">
          {column === "listen_again" && state.coldStart
            ? t("subscriptions.forYou.empty.listenAgainCold")
            : t(`subscriptions.forYou.empty.${column}`)}
        </p>
      ) : (
        <ol
          className={cn(
            "grid gap-3 transition-opacity @2xl:grid-cols-2 @5xl:grid-cols-1",
            state.drawing && "opacity-60",
          )}
          aria-busy={state.drawing}
        >
          {state.items.map((item, index) => (
            <ForYouCard
              key={item.work.id}
              item={item}
              canMark={canMark}
              onOpen={() => onOpen(item, index + 1)}
              onPatch={onPatch}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function ForYouCard({
  item,
  canMark,
  onOpen,
  onPatch,
}: {
  item: ForYouItem;
  canMark: boolean;
  onOpen: () => void;
  onPatch: (workId: number, patch: Partial<Work>) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolvedLocale } = useLocale();
  const work = item.work;
  const reason = forYouReasonText(item.reason, t, (value) => formatRating(value, resolvedLocale));
  const changeStatus = async (status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(work.id, { listeningStatus: status });
      onPatch(work.id, { listeningStatus: result.listeningStatus, favorite: result.favorite });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };
  const changeRating = async (rating: number | null) => {
    try {
      const result = await api.updateWorkUserState(work.id, { userRating: rating });
      onPatch(work.id, { userRating: result.userRating });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };
  return (
    <li aria-label={work.title} className="flex min-w-0 flex-col gap-1.5">
      <p className="h-5 min-w-0 truncate px-1 text-xs text-muted-foreground" title={reason}>
        {reason}
      </p>
      <CompactWorkCardShell
        layout="row"
        work={forYouCardView(work, t("workCard.unknownCircle"))}
        onOpen={onOpen}
        onCircleOpen={(externalId: string) => openCircleRoute(externalId)}
        footer={
          <WorkCardFooter
            className="h-10 border-border/40"
            left={<WorkCardDLsiteAction href={work.dlsiteUrl} />}
            right={
              canMark && (
                <>
                  <WorkCardListButton
                    workId={work.id}
                    active={work.favorite}
                    memberLists={work.memberLists}
                    fitLabel
                    onSaved={(favorite) => onPatch(work.id, { favorite })}
                  />
                  <WorkRatingControl
                    variant="card"
                    value={work.userRating ?? null}
                    onChange={(rating) => void changeRating(rating)}
                  />
                  <WorkCardQuickMarkButton
                    value={work.listeningStatus}
                    onChange={(status) => void changeStatus(status)}
                  />
                </>
              )
            }
          />
        }
      />
    </li>
  );
}

function forYouCardView(work: Work, unknownCircle: string): WorkCardViewModel {
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
    sourceBadges: sourcePresenceBadges(work.sourcePresence, work.availability),
    sourceBadgeStyle: "icon",
  };
}

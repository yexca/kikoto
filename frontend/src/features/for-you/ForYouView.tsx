import { Compass, Repeat, Shuffle, Sparkles, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import {
  CompactWorkCardSkeleton,
  LayoutWorkCard,
  type CompactWorkCardLayout,
} from "@/components/work-card/CompactWorkCard";
import { sourcePresenceBadges } from "@/components/work-card/sourceBadges";
import { WorkCardActionFooter } from "@/components/work-card/WorkCardActionFooter";
import { WorkCardContextItem, WorkCardContextStrip } from "@/components/work-card/WorkCardContext";
import {
  dlsiteTagBadges,
  formatRating,
  userTagBadges,
  type WorkCardViewModel,
} from "@/components/work-card/WorkCardShell";
import {
  workCollectionClassName,
  workCollectionStyle,
  type WorkCollectionColumnSetting,
} from "@/components/work-collection/WorkCollectionLayout";
import { WorkSectionHeading } from "@/components/work-collection/WorkSectionHeading";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type Work } from "@/lib/api";
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

// Side by side, each column is a single track of row cards.
const sideBySideListClassName =
  "@5xl:[--mobile-grid-template:minmax(0,1fr)] @5xl:[--desktop-grid-template:minmax(0,1fr)]";

/**
 * For you: three small draws from the local library, Maybe like, Try new,
 * and Listen again, under one temperature. Narrow views switch between the
 * columns. Wide views put row cards in three columns side by side; a third of
 * the width is too narrow for full cards and too short a run for mini covers,
 * so those modes stack the three columns as sections in Discover's card grid.
 * Cards offer the Library's own actions, and opening one records an open so
 * later draws rotate.
 */
export function ForYouView({
  canMark,
  cardLayout,
  mobileColumns,
  desktopColumns,
  onOpenWork,
}: {
  canMark: boolean;
  /** Discover's card layout, or null for the regular card. */
  cardLayout: CompactWorkCardLayout | null;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  onOpenWork: (code: string) => void;
}) {
  const { t } = useTranslation();
  const forYou = useForYou(true);
  const [shown, setShown] = useState<ForYouColumn>("maybe_like");
  const coldStart = FOR_YOU_COLUMNS.some((column) => forYou.columns[column].coldStart);
  const sideBySide = cardLayout === "row";

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
          <div
            className={sideBySide ? "grid items-start gap-4 @5xl:grid-cols-3 @5xl:gap-5" : "flex flex-col gap-6"}
            style={workCollectionStyle(mobileColumns, desktopColumns, cardLayout)}
          >
            {FOR_YOU_COLUMNS.map((column) => (
              <ForYouColumnSection
                key={column}
                column={column}
                state={forYou.columns[column]}
                className={shown === column ? undefined : "hidden @5xl:block"}
                cardLayout={cardLayout}
                listClassName={sideBySide ? sideBySideListClassName : undefined}
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
  cardLayout,
  listClassName,
  canMark,
  onDrawAgain,
  onOpen,
  onPatch,
}: {
  column: ForYouColumn;
  state: ForYouColumnState;
  className?: string;
  cardLayout: CompactWorkCardLayout | null;
  listClassName?: string;
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
    <section id={`for-you-${column}`} aria-labelledby={headingId} className={cn("min-w-0", className)}>
      <WorkSectionHeading
        id={headingId}
        icon={<Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        title={title}
        count={loading ? undefined : state.items.length}
        countLabel={t("subscriptions.feed.dayCount", { count: state.items.length })}
        description={t(`subscriptions.forYou.descriptions.${column}`)}
        action={
          <Button
            variant="toolbar"
            size="sm"
            className="gap-1.5"
            disabled={state.drawing}
            aria-label={t("subscriptions.forYou.drawAgainColumn", { column: title })}
            title={t("subscriptions.forYou.drawAgainColumn", { column: title })}
            onClick={onDrawAgain}
          >
            <Shuffle className={cn("h-3.5 w-3.5", state.drawing && "animate-pulse")} aria-hidden="true" />
            {t("subscriptions.forYou.drawAgain")}
          </Button>
        }
      />
      {loading ? (
        <div className={cn(workCollectionClassName(), listClassName)} aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5">
              <div className="h-6" />
              <CompactWorkCardSkeleton layout={cardLayout ?? "tile"} />
            </div>
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
          className={cn(workCollectionClassName(), listClassName, "transition-opacity", state.drawing && "opacity-60")}
          aria-busy={state.drawing}
        >
          {state.items.map((item, index) => (
            <ForYouCard
              key={item.work.id}
              item={item}
              cardLayout={cardLayout}
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
  cardLayout,
  canMark,
  onOpen,
  onPatch,
}: {
  item: ForYouItem;
  cardLayout: CompactWorkCardLayout | null;
  canMark: boolean;
  onOpen: () => void;
  onPatch: (workId: number, patch: Partial<Work>) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const work = item.work;
  const reason = forYouReasonText(item.reason, t, (value) => formatRating(value, resolvedLocale));
  return (
    <WorkCardContextItem label={work.title} context={<WorkCardContextStrip detail={reason} />}>
      <LayoutWorkCard
        layout={cardLayout}
        work={forYouCardView(work, t("workCard.unknownCircle"))}
        onOpen={onOpen}
        onCircleOpen={(externalId: string) => openCircleRoute(externalId)}
        footer={
          <WorkCardActionFooter
            layout={cardLayout}
            dlsiteUrl={work.dlsiteUrl}
            work={work}
            canMark={canMark}
            onWorkChange={onPatch}
          />
        }
      />
    </WorkCardContextItem>
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

import {
  Bookmark,
  CirclePause,
  Compass,
  Headphones,
  History,
  MicVocal,
  Repeat,
  Shuffle,
  Sparkles,
  Star,
  Tag,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { DemoPreviewNotice } from "@/components/DemoReadOnlyNotice";
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
import { FOR_YOU_COLUMNS, type ForYouColumn, type ForYouItem, type ForYouReason } from "@/lib/forYouApi";
import { openCircleRoute } from "@/lib/circleNavigationState";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { cn } from "@/lib/tailwindClassNames";

import { readForYouColumnPreference, writeForYouColumnPreference } from "./forYouColumnPreference";
import { forYouReasonText, type ForYouColumnState } from "./forYouModel";
import { ForYouTemperaturePicker } from "./ForYouTemperaturePicker";
import { useForYou } from "./useForYou";

const COLUMN_ICONS: Record<ForYouColumn, LucideIcon> = {
  maybe_like: Sparkles,
  try_new: Compass,
  listen_again: Repeat,
};

// What a reason rests on: the circle, voice, or tag it names, a rating, or a past play.
const REASON_ICONS: Record<ForYouReason["kind"], LucideIcon> = {
  liked_circle: Users,
  new_circle: Users,
  liked_voice: MicVocal,
  new_voice: MicVocal,
  liked_tag: Tag,
  rare_tag: Tag,
  want: Bookmark,
  dlsite_rating: Star,
  popular: TrendingUp,
  unexplored: Headphones,
  since_played: History,
  unfinished: CirclePause,
};

// Side by side, each column is a single track of row cards.
const sideBySideListClassName =
  "@5xl:[--mobile-grid-template:minmax(0,1fr)] @5xl:[--desktop-grid-template:minmax(0,1fr)]";

/**
 * For you: three small draws from the local library, Maybe like, Try new,
 * and Listen again, under one temperature. Narrow views switch between the
 * columns. Wide views put row cards in three columns side by side; a third of
 * the width is too narrow for full or simple cards and too short a run for
 * mini covers, so those modes stack the three columns as sections in
 * the card grid.
 * Cards offer the Library's own actions, and opening one records an open so
 * later draws rotate. The draw stays as drawn for the browser session.
 */
export function ForYouView(props: ForYouViewProps) {
  const auth = useAuth();
  const storageScope = currentClientStorageScope(auth.user?.id ?? null);
  // Remount on account or server changes so one account's draw never shows for another.
  return <ForYouDraws key={storageScope} storageScope={storageScope} {...props} />;
}

type ForYouViewProps = {
  canMark: boolean;
  /** The page's controls, at the end of the temperature row. */
  toolbar?: ReactNode;
  /** The card layout, or null for the regular card. */
  cardLayout: CompactWorkCardLayout | null;
  mobileColumns: WorkCollectionColumnSetting;
  desktopColumns: WorkCollectionColumnSetting;
  onOpenWork: (code: string) => void;
};

function ForYouDraws({
  storageScope,
  canMark,
  toolbar,
  cardLayout,
  mobileColumns,
  desktopColumns,
  onOpenWork,
}: ForYouViewProps & { storageScope: string }) {
  const { t } = useTranslation();
  const { demoMode } = useAuth();
  const forYou = useForYou(storageScope);
  const [shown, setShown] = useState<ForYouColumn>(() => readForYouColumnPreference(storageScope));
  const show = (column: ForYouColumn) => {
    setShown(column);
    writeForYouColumnPreference(storageScope, column);
  };
  const sideBySide = cardLayout === "row";

  const open = (column: ForYouColumn, item: ForYouItem, rank: number) => {
    // Demo draws are samples and record nothing.
    if (demoMode) {
      onOpenWork(item.work.primaryCode);
      return;
    }
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
      {demoMode && <DemoPreviewNotice surface="forYou" />}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-toast-avoid>
        <ForYouTemperaturePicker value={forYou.temperature} onChange={(item) => void forYou.changeTemperature(item)} />
        {toolbar && <div className="ml-auto flex shrink-0 items-center gap-1">{toolbar}</div>}
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
          {/* Below the three-column width one column shows at a time; its tab
              names it, so the column heading gives way to this row. */}
          <div className="flex min-w-0 items-center gap-2 @5xl:hidden">
            <div
              role="tablist"
              aria-label={t("subscriptions.forYou.columnsLabel")}
              className={segmentedListClassName("scrollbar-hidden")}
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
                    onClick={() => show(column)}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {t(`subscriptions.forYou.columns.${column}`)}
                  </button>
                );
              })}
            </div>
            <DrawAgainButton
              className="ml-auto"
              column={shown}
              drawing={forYou.columns[shown].drawing}
              onClick={() => void forYou.drawColumn(shown)}
            />
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
      {/* Hidden while the tabs name the column; it still names the section. */}
      <WorkSectionHeading
        id={headingId}
        className="hidden @5xl:block"
        icon={<Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        title={title}
        action={<DrawAgainButton column={column} drawing={state.drawing} onClick={onDrawAgain} />}
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

/** Draws one column anew; an icon, since every column offers it. */
function DrawAgainButton({
  column,
  drawing,
  className,
  onClick,
}: {
  column: ForYouColumn;
  drawing: boolean;
  className?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const label = t("subscriptions.forYou.drawAgainColumn", { column: t(`subscriptions.forYou.columns.${column}`) });
  return (
    <Button
      variant="toolbar"
      size="icon-sm"
      className={cn("shrink-0", className)}
      disabled={drawing}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Shuffle className={cn("h-4 w-4", drawing && "animate-pulse")} aria-hidden="true" />
    </Button>
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
  // An unknown kind from a newer server still shows its sentence, under the column's own mark.
  const ReasonIcon = REASON_ICONS[item.reason.kind] ?? Sparkles;
  return (
    <WorkCardContextItem
      label={work.title}
      context={
        <WorkCardContextStrip>
          {/* The reason is what the card is here for, so it reads at body weight with its mark in the accent. */}
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/85" title={reason}>
            <ReasonIcon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{reason}</span>
          </span>
        </WorkCardContextStrip>
      }
    >
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

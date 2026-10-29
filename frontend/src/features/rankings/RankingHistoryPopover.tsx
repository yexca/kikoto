import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName } from "@/components/ui/segmented";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type RankingList, type RankingPage, type RankingSnapshotRef, type RankingVariant } from "@/lib/api";
import { parseServerTimestamp } from "@/lib/serverTimestamp";

import {
  formatRankingTime,
  rankingDayAt,
  rankingDayIsDailyOnly,
  rankingInstant,
  zonedDay,
  zonedDayRange,
} from "./rankingModel";
import { useRankingPopover } from "./useRankingPopover";

/**
 * The History tool: an icon that opens a compact time travel for the shown
 * order. Choosing a day, one of its updates, or the update before or after
 * shows the order in effect then; the banner under the toolbar leads back.
 */
export function RankingHistoryPopover({
  list,
  variant,
  page,
  at,
  timeZone,
  onAtChange,
}: {
  list: RankingList;
  variant: RankingVariant;
  page: RankingPage;
  at: string | null;
  timeZone: string;
  onAtChange: (at: string | null) => void;
}) {
  const { t } = useTranslation();
  const { anchorRef, contentRef, open, setOpen } = useRankingPopover("input[type='date']");
  return (
    <>
      <Button
        ref={anchorRef}
        size="icon-sm"
        variant={at ? "secondary" : "ghost"}
        aria-label={t("subscriptions.rankings.history.open")}
        title={t("subscriptions.rankings.history.open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <History className="h-4 w-4" />
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align="end"
        onOpenChange={setOpen}
        ariaLabel={t("subscriptions.rankings.history.label")}
        className="w-[min(22rem,calc(100vw-1.5rem))] p-3 text-sm"
      >
        <div ref={contentRef}>
          <RankingTimeTravel
            key={`${list.id}:${variant.id}`}
            list={list}
            variant={variant}
            page={page}
            at={at}
            timeZone={timeZone}
            onAtChange={onAtChange}
          />
        </div>
      </AnchoredPopover>
    </>
  );
}

/** The updates loaded for one day, and the cursor of the rest. */
type DayTimeline = { key: string; updates: RankingSnapshotRef[]; more: number | null; failed: boolean };

/**
 * Chooses a time in a ranking's history: a day in the account's time zone,
 * that day's updates, and the update before or after the one shown.
 */
function RankingTimeTravel({
  list,
  variant,
  page,
  at,
  timeZone,
  onAtChange,
}: {
  list: RankingList;
  variant: RankingVariant;
  page: RankingPage;
  at: string | null;
  timeZone: string;
  onAtChange: (at: string | null) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const time = (value: string | null | undefined) => formatRankingTime(value, resolvedLocale, timeZone);
  const now = Date.now();
  const today = zonedDay(now, timeZone);
  const shownTime = at ? Date.parse(at) : (parseServerTimestamp(page.snapshot?.pulledAt)?.getTime() ?? now);
  const day = zonedDay(shownTime, timeZone);
  const first = parseServerTimestamp(page.history.firstPulledAt);
  const firstDay = first ? zonedDay(first.getTime(), timeZone) : today;
  // The updates belong to the day they were loaded for, so a response that
  // arrives after another day was chosen is never shown with it.
  const dayKey = `${timeZone}:${day}`;
  const [timeline, setTimeline] = useState<DayTimeline | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const dayLoad = useRef<AbortController | null>(null);
  const shown = timeline?.key === dayKey ? timeline : null;

  useEffect(() => {
    const controller = new AbortController();
    dayLoad.current = controller;
    const range = zonedDayRange(day, timeZone);
    api
      .listRankingSnapshots(
        list.id,
        {
          from: new Date(range.start).toISOString(),
          to: new Date(range.end).toISOString(),
          releaseWindow: variant.releaseWindow,
          sort: variant.sort,
        },
        controller.signal,
      )
      .then((page) => setTimeline({ key: dayKey, updates: page.snapshots, more: page.nextAfterId, failed: false }))
      .catch(() => {
        if (!controller.signal.aborted) setTimeline({ key: dayKey, updates: [], more: null, failed: true });
      });
    return () => controller.abort();
  }, [day, dayKey, list.id, timeZone, variant.releaseWindow, variant.sort]);

  // More continues the shown day under its load, so choosing another day
  // stops it.
  const loadMore = () => {
    const controller = dayLoad.current;
    if (!shown || shown.more === null || !controller || loadingMore) return;
    const { key, more } = shown;
    const range = zonedDayRange(day, timeZone);
    setLoadingMore(true);
    api
      .listRankingSnapshots(
        list.id,
        {
          to: new Date(range.end).toISOString(),
          afterId: more,
          releaseWindow: variant.releaseWindow,
          sort: variant.sort,
        },
        controller.signal,
      )
      .then((page) =>
        setTimeline((current) =>
          current?.key === key
            ? { key, updates: [...current.updates, ...page.snapshots], more: page.nextAfterId, failed: false }
            : current,
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setTimeline((current) => (current?.key === key ? { ...current, failed: true } : current));
      })
      .finally(() => setLoadingMore(false));
  };
  const updates = shown?.updates ?? [];
  const noUpdates = shown?.failed === false && updates.length === 0;
  const go = (snapshot: RankingSnapshotRef | null) => snapshot && onAtChange(rankingInstant(snapshot.pulledAt));
  const coverage = page.coverage;
  const notes: string[] = [];
  if (at && page.snapshot) {
    notes.push(
      t("subscriptions.rankings.history.pulled", {
        pulled: time(page.snapshot.pulledAt),
        confirmed: time(page.snapshot.confirmedUntil),
      }),
    );
  }
  if (coverage?.state === "unpulled") {
    notes.push(t("subscriptions.rankings.history.unpulled", { confirmed: time(coverage.confirmedUntil) }));
  }
  if (coverage?.state === "before") {
    notes.push(t("subscriptions.rankings.history.before", { time: time(page.history.firstPulledAt) }));
  }
  if (shown?.failed) notes.push(t("subscriptions.rankings.history.updatesFailed"));
  if (rankingDayIsDailyOnly(day, timeZone, page.history.fullFrom))
    notes.push(t("subscriptions.rankings.history.dailyOnly"));
  notes.push(t("subscriptions.rankings.history.timeZone", { zone: timeZone }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("subscriptions.rankings.history.previous")}
          title={t("subscriptions.rankings.history.previous")}
          disabled={!page.previousSnapshot}
          onClick={() => go(page.previousSnapshot)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{t("subscriptions.rankings.history.date")}</span>
          <Input
            type="date"
            value={day}
            min={firstDay}
            max={today}
            className="h-8 min-w-0 flex-1"
            onChange={(event) => {
              const next = event.target.value;
              if (next) onAtChange(rankingDayAt(next, timeZone, Date.now()));
            }}
          />
        </label>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("subscriptions.rankings.history.next")}
          title={t("subscriptions.rankings.history.next")}
          disabled={!page.nextSnapshot}
          onClick={() => go(page.nextSnapshot)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div
        role="group"
        aria-label={t("subscriptions.rankings.history.updates")}
        className="flex max-h-40 flex-wrap gap-1 overflow-y-auto"
      >
        {noUpdates ? (
          <span className="text-xs text-muted-foreground">{t("subscriptions.rankings.history.noUpdates")}</span>
        ) : (
          updates.map((update) => {
            const current = page.snapshot?.id === update.id;
            return (
              <button
                key={update.id}
                type="button"
                aria-pressed={current}
                className={segmentedItemClassName(current, "h-7 border px-2 text-xs tabular-nums")}
                onClick={() => go(update)}
              >
                {formatRankingTime(update.pulledAt, resolvedLocale, timeZone, "time")}
              </button>
            );
          })
        )}
        {shown && shown.more !== null && (
          <Button size="sm" variant="ghost" className="h-7" disabled={loadingMore} onClick={loadMore}>
            {t("subscriptions.rankings.history.more")}
          </Button>
        )}
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground" role="status">
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      {at && (
        <div className="flex justify-end border-t pt-2">
          <Button size="sm" variant="ghost" onClick={() => onAtChange(null)}>
            {t("subscriptions.rankings.history.backToLatest")}
          </Button>
        </div>
      )}
    </div>
  );
}

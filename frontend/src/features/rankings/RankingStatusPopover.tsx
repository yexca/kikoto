import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/i18n/LocaleProvider";
import type { RankingPage } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { formatRankingStamp, formatRankingTime, zonedWallTime } from "./rankingModel";
import { useRankingPopover } from "./useRankingPopover";

/**
 * When the shown order was updated and what it is compared with, as one short
 * button. It opens the full times and the comparison choice: the last visit
 * (or, for a past order, the update before it), the previous update, or
 * another time. A finished annual ranking states its final order instead.
 */
export function RankingStatusPopover({
  page,
  compare,
  timeZone,
  onCompareChange,
}: {
  page: RankingPage;
  /** "" for the default, "previous", a snapshot id, or an ISO time. */
  compare: string;
  timeZone: string;
  onCompareChange: (compare: string) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const { anchorRef, contentRef, open, setOpen } = useRankingPopover("[role='radio'][aria-checked='true']");
  const now = Date.now();
  const full = (value: string | null | undefined) => formatRankingTime(value, resolvedLocale, timeZone);
  const short = (value: string | null | undefined) => formatRankingStamp(value, resolvedLocale, timeZone, now);
  const list = page.list;
  const history = page.at !== null;
  const baseline = page.baseline;

  if (list.finalAt !== null) {
    return (
      <p className="truncate text-xs text-muted-foreground">
        {t("subscriptions.rankings.archive", { year: list.year, time: full(list.finalAt) })}
      </p>
    );
  }

  const shown = history
    ? t("subscriptions.rankings.shownAt", { time: short(page.at) })
    : t("subscriptions.rankings.updated", { time: short(page.snapshot?.pulledAt) });
  const versus = baseline
    ? t(`subscriptions.rankings.versus.${baseline.kind}`, { time: short(baseline.pulledAt) })
    : t("subscriptions.rankings.versus.none");
  return (
    <>
      <Button
        ref={anchorRef}
        size="sm"
        variant="ghost"
        className="h-8 max-w-full gap-1 px-2 font-normal text-muted-foreground hover:text-foreground"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="truncate">
          <span className="font-medium text-foreground">{shown}</span>
          {" · "}
          {versus}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        align="end"
        onOpenChange={setOpen}
        ariaLabel={t("subscriptions.rankings.details")}
        className="w-[min(20rem,calc(100vw-1.5rem))] p-3 text-sm"
      >
        <div ref={contentRef} className="space-y-3">
          <div className="space-y-0.5">
            <p className="font-medium">
              {history
                ? t("subscriptions.rankings.history.showing", { time: full(page.at) })
                : t("subscriptions.rankings.updated", { time: full(page.snapshot?.pulledAt) })}
            </p>
            <p className="text-xs text-muted-foreground">
              {baseline
                ? t(`subscriptions.rankings.comparedWith.${baseline.kind}`, { time: full(baseline.pulledAt) })
                : t("subscriptions.rankings.comparedWith.none")}
            </p>
          </div>
          {(page.previousSnapshot || baseline) && (
            <RankingCompareChoice
              history={history}
              compare={compare}
              timeZone={timeZone}
              onCompareChange={(next) => {
                onCompareChange(next);
                if (!next.includes("T")) setOpen(false);
              }}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {t("subscriptions.rankings.history.timeZone", { zone: timeZone })}
          </p>
        </div>
      </AnchoredPopover>
    </>
  );
}

function RankingCompareChoice({
  history,
  compare,
  timeZone,
  onCompareChange,
}: {
  history: boolean;
  compare: string;
  timeZone: string;
  onCompareChange: (compare: string) => void;
}) {
  const { t } = useTranslation();
  const timedCompare = compare.includes("T");
  const [choosingTime, setChoosingTime] = useState(timedCompare);
  const value = timedCompare || choosingTime ? "time" : compare === "previous" ? "previous" : "";
  const options = [
    { value: "", label: t(history ? "subscriptions.rankings.compare.before" : "subscriptions.rankings.compare.seen") },
    ...(history ? [] : [{ value: "previous", label: t("subscriptions.rankings.compare.previous") }]),
    { value: "time", label: t("subscriptions.rankings.compare.time") },
  ];
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground" aria-hidden="true">
        {t("subscriptions.rankings.compareWith")}
      </p>
      <div role="radiogroup" aria-label={t("subscriptions.rankings.compareWith")} className="grid gap-0.5">
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <button
              key={option.value || "default"}
              type="button"
              role="radio"
              aria-checked={checked}
              className={cn(
                "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                checked && "bg-primary/10 text-primary",
              )}
              onClick={() => {
                setChoosingTime(option.value === "time");
                if (option.value !== "time") onCompareChange(option.value);
              }}
            >
              <Check className={cn("h-4 w-4 shrink-0", !checked && "invisible")} aria-hidden="true" />
              {option.label}
            </button>
          );
        })}
      </div>
      {value === "time" && (
        <Input
          type="datetime-local"
          aria-label={t("subscriptions.rankings.compareTime")}
          className="h-9"
          onChange={(event) => {
            const instant = zonedWallTime(event.target.value, timeZone);
            if (instant) onCompareChange(instant);
          }}
        />
      )}
    </div>
  );
}

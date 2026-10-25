import { History } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { FloatingSelect } from "@/components/ui/floating-select";
import { filterChipClassName, segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import type { RankingList, RankingOrder } from "@/lib/api";

import {
  rankingChipSegmentLabel,
  rankingOffersReleaseWindow,
  rankingOffersSalesOrder,
  type RankingChip,
  type RankingChipGroup,
  type RankingFilter,
} from "./rankingModel";

// Phones scroll a control row sideways from edge to edge; wider screens wrap it. The
// strip is the containing block of its screen-reader labels, so they are clipped with it.
const scrollStripClassName =
  "relative max-sm:overflow-x-auto max-sm:overflow-y-hidden max-sm:[scrollbar-width:none] sm:flex-wrap max-sm:[&::-webkit-scrollbar]:hidden";
const compactSegmentClassName = "h-7 px-2.5 text-xs";

/**
 * The controls above a ranking, which stay under the app header while its
 * entries scroll: which ranking, with the history and refresh tools, then the
 * shown order, the filters, and the update status, and a banner while a past
 * time is shown.
 */
export function RankingToolbar({
  chooser,
  tools,
  order,
  filters,
  status,
  banner,
}: {
  chooser: ReactNode;
  tools: ReactNode;
  order: ReactNode;
  filters: ReactNode;
  status: ReactNode;
  banner: ReactNode;
}) {
  return (
    <div className="sticky top-[calc(var(--header-height)+var(--safe-area-top))] z-20 -mx-1 space-y-2 border-b bg-background/95 px-1 pb-2 pt-1 backdrop-blur lg:top-[var(--header-height)]">
      <div className="flex items-center gap-2">
        {chooser}
        <div className="flex shrink-0 items-center gap-0.5">{tools}</div>
      </div>
      {(order || filters || status) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {(order || filters) && (
            <div
              className={`flex min-w-0 items-center gap-2 max-sm:-mx-4 max-sm:w-[calc(100%+2rem)] max-sm:px-4 ${scrollStripClassName}`}
            >
              {order}
              {order && filters && <span className="h-5 w-px shrink-0 bg-border" aria-hidden="true" />}
              {filters}
            </div>
          )}
          {status && <div className="min-w-0 sm:ml-auto">{status}</div>}
        </div>
      )}
      {banner}
    </div>
  );
}

/**
 * Chooses the ranking: segmented controls grouped by provider, naming the
 * provider once. The annual lists share one segment with a year choice beside
 * it. A dot marks a ranking whose shown order changed since the last visit.
 */
export function RankingChooser({
  groups,
  selectedChip,
  selectedList,
  unseen,
  onListChange,
}: {
  groups: RankingChipGroup[];
  selectedChip: RankingChip | null;
  selectedList: RankingList;
  unseen: (chip: RankingChip) => boolean;
  onListChange: (listId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("subscriptions.rankings.listsLabel")}
      className={`flex min-w-0 flex-1 items-center gap-x-3 gap-y-2 max-sm:-ml-4 max-sm:pl-4 ${scrollStripClassName}`}
    >
      {groups.map((group) => (
        <div key={group.key} className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground" aria-hidden="true">
            {group.label}
          </span>
          <div role="tablist" aria-label={group.label} className={segmentedListClassName("max-w-none p-0.5")}>
            {group.chips.map((chip) => {
              const active = chip === selectedChip;
              return (
                <button
                  key={chip.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={segmentedItemClassName(active, `${compactSegmentClassName} gap-1.5`)}
                  onClick={() => onListChange(chip.lists[0].id)}
                >
                  <span className="sr-only">{`${group.label} · `}</span>
                  {rankingChipSegmentLabel(chip, t)}
                  {unseen(chip) && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      title={t("subscriptions.rankings.unseen")}
                    >
                      <span className="sr-only">{t("subscriptions.rankings.unseen")}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {selectedChip?.key === "annual" && group.chips.includes(selectedChip) && selectedChip.lists.length > 1 && (
            <FloatingSelect
              value={String(selectedList.id)}
              options={selectedChip.lists.map((list) => ({ value: String(list.id), label: String(list.year) }))}
              ariaLabel={t("subscriptions.rankings.year")}
              onValueChange={(value) => onListChange(Number(value))}
              className="h-8 w-[5.5rem]"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Chooses the order a DLsite ranking shows: popularity or sales, and the
 * 30-day window where the period offers it. These choose the list itself;
 * the filters beside them only narrow the shown order's items.
 */
export function RankingOrderControls({
  list,
  order,
  onOrderChange,
}: {
  list: RankingList;
  order: RankingOrder;
  onOrderChange: (order: RankingOrder) => void;
}) {
  const { t } = useTranslation();
  const sales = rankingOffersSalesOrder(list);
  const offersWindow = rankingOffersReleaseWindow(list);
  if (!sales && !offersWindow) return null;
  const recent = order.releaseWindow === "30d";
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {sales && (
        <div
          role="radiogroup"
          aria-label={t("subscriptions.rankings.order.sortLabel")}
          className={segmentedListClassName("max-w-none p-0.5")}
        >
          {(["", "sale"] as const).map((value) => (
            <button
              key={value || "popularity"}
              type="button"
              role="radio"
              aria-checked={order.sort === value}
              className={segmentedItemClassName(order.sort === value, compactSegmentClassName)}
              onClick={() => order.sort !== value && onOrderChange({ ...order, sort: value })}
            >
              {t(value ? "subscriptions.rankings.order.sales" : "subscriptions.rankings.order.popularity")}
            </button>
          ))}
        </div>
      )}
      {offersWindow && (
        <button
          type="button"
          role="switch"
          aria-checked={recent}
          className={filterChipClassName(recent)}
          onClick={() => onOrderChange({ ...order, releaseWindow: recent ? "" : "30d" })}
        >
          {t("subscriptions.rankings.order.releaseWindow")}
        </button>
      )}
    </div>
  );
}

/** Narrows the shown order's entries, with how many each filter keeps. */
export function RankingFilterControl({
  filters,
  filter,
  counts,
  onFilterChange,
}: {
  filters: readonly RankingFilter[];
  filter: RankingFilter;
  counts: Record<RankingFilter, number>;
  onFilterChange: (filter: RankingFilter) => void;
}) {
  const { t } = useTranslation();
  const active = filters.includes(filter) ? filter : "all";
  return (
    <div
      role="group"
      aria-label={t("subscriptions.rankings.filtersLabel")}
      className={segmentedListClassName("max-w-none shrink-0 p-0.5")}
    >
      {filters.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={active === option}
          className={segmentedItemClassName(active === option, `${compactSegmentClassName} gap-1.5`)}
          onClick={() => onFilterChange(option)}
        >
          {t(`subscriptions.rankings.filters.${option}`)}
          <span className="font-normal tabular-nums text-muted-foreground">{counts[option]}</span>
        </button>
      ))}
    </div>
  );
}

/** Says that a past time is shown, with the way back to the latest order. */
export function RankingHistoryBanner({ label, onLatest }: { label: string; onLatest: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-info-border bg-info-surface px-3 py-1.5 text-xs text-info-foreground"
      role="status"
    >
      <History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button
        type="button"
        className="shrink-0 rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onLatest}
      >
        {t("subscriptions.rankings.history.backToLatest")}
      </button>
    </div>
  );
}

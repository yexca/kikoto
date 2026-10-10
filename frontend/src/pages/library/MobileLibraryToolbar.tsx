import { ArrowDown, ArrowUp, ArrowUpDown, Check, Plus, RefreshCw, Search, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import { Button } from "@/components/ui/button";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { listeningStatusOptions } from "@/features/work-detail/workDetailShared";
import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { LibrarySort, ListeningStatus, SortDirection } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

export type MobileLibrarySortProps = {
  options: { value: LibrarySort; label: string }[];
  value: LibrarySort;
  direction: SortDirection;
  onChange: (value: LibrarySort) => void;
  onDirectionChange: (value: SortDirection) => void;
  onReshuffle: () => void;
};

/**
 * The phone Library header: an always-visible search field, the source rail,
 * sort and view controls, quick-mark filter chips, and a result caption. It
 * replaces the desktop toolbar's row of icon buttons, which on a phone hid
 * search behind a toggle and filters behind an unlabeled popover.
 */
export function MobileLibraryToolbar({
  sourceTabs,
  searchQuery,
  onSearchChange,
  onAddClause,
  addClauseOpen,
  resultCount,
  resultPage,
  sort,
  actions,
  statusFilter,
  onStatusFilterChange,
  children,
}: {
  sourceTabs: ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  resultCount: number | null;
  /** Shown beside the count when the results span more than one page. */
  resultPage: { page: number; totalPages: number };
  sort: MobileLibrarySortProps;
  actions: ReactNode;
  /** Null when the active view cannot filter by quick mark. */
  statusFilter: ListeningStatus | "all" | null;
  onStatusFilterChange: (value: ListeningStatus | "all") => void;
  /** Rendered between the source rail and the result line. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  return (
    <div className="space-y-3" data-toast-avoid>
      <div className="search-field flex h-11 min-w-0 items-center gap-2 rounded-full border bg-card pl-4 pr-1.5 text-sm shadow-sm transition-colors focus-within:border-primary/50">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          type="search"
          enterKeyHint="search"
          value={searchQuery}
          onKeyDown={dismissKeyboardOnEnter}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("library.mobileSearchPlaceholder")}
          aria-label={t("library.searchLibrary")}
        />
        {searchQuery.trim() && (
          <button
            type="button"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onSearchChange("")}
            aria-label={t("library.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground hover:text-foreground",
            addClauseOpen && "bg-primary/10 text-primary",
          )}
          onClick={(event) => onAddClause(event.currentTarget)}
          aria-label={t("library.addSearchCondition")}
          aria-haspopup="dialog"
          aria-expanded={addClauseOpen}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sourceTabs}
      </div>
      {children}
      <div className="flex min-h-9 items-center gap-2">
        <MobileSortButton {...sort} />
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {statusFilter !== null && <StatusChips value={statusFilter} onChange={onStatusFilterChange} />}
      <p className="flex min-h-5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {resultCount !== null && (
          <>
            <span className="truncate font-semibold text-foreground">
              {t("library.resultCount", { value: numberFormat(resolvedLocale).format(resultCount) })}
            </span>
            {resultPage.totalPages > 1 && (
              <>
                <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
                <span className="shrink-0 tabular-nums">
                  {t("library.resultPage", {
                    page: numberFormat(resolvedLocale).format(resultPage.page),
                    totalPages: numberFormat(resolvedLocale).format(resultPage.totalPages),
                  })}
                </span>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

function StatusChips({
  value,
  onChange,
}: {
  value: ListeningStatus | "all";
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "border-primary/30 bg-primary/10 text-primary"
        : "border-border bg-card text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label={t("library.markFilter")}
    >
      <button
        type="button"
        className={chip(value === "all")}
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        {t("library.allStatuses")}
      </button>
      {listeningStatusOptions.map((option) => {
        const meta = quickMarkMeta(option.value);
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={chip(active)}
            aria-pressed={active}
            onClick={() => onChange(active ? "all" : option.value)}
          >
            <meta.icon className={cn("h-3.5 w-3.5", !active && meta.className)} aria-hidden="true" />
            {t(`library.status.${option.value}`, { defaultValue: option.label })}
          </button>
        );
      })}
    </div>
  );
}

function MobileSortButton({
  options,
  value,
  direction,
  onChange,
  onDirectionChange,
  onReshuffle,
}: MobileLibrarySortProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const label = t(`library.sortOptions.${value}`, {
    defaultValue: options.find((option) => option.value === value)?.label ?? t("library.sort"),
  });
  const random = value === "random";
  const directionLabel = direction === "asc" ? t("library.ascending") : t("library.descending");
  return (
    <div className="relative min-w-0" ref={anchorRef}>
      <button
        type="button"
        className="inline-flex h-9 max-w-full min-w-0 shrink items-center gap-1.5 rounded-full border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("library.sortLabel", { label })}
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{label}</span>
        {!random &&
          (direction === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ))}
      </button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        ariaLabel={t("library.sort")}
        bottomCollisionPadding={168}
        className="w-[min(15rem,calc(100vw-1.5rem))] space-y-1.5 p-1.5 text-sm"
      >
        {random ? (
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-full gap-2"
            onClick={() => {
              onReshuffle();
              setOpen(false);
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t("library.reshuffle")}
          </Button>
        ) : (
          <div className={segmentedListClassName("grid w-full grid-cols-2")} role="group" aria-label={directionLabel}>
            {(["desc", "asc"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={segmentedItemClassName(direction === item, "justify-center gap-1.5 px-2 text-xs")}
                aria-pressed={direction === item}
                onClick={() => onDirectionChange(item)}
              >
                {item === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {item === "asc" ? t("library.ascending") : t("library.descending")}
              </button>
            ))}
          </div>
        )}
        <ul>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left transition-colors hover:bg-muted",
                    selected ? "bg-primary/10 font-medium text-primary" : "text-foreground",
                  )}
                  aria-pressed={selected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    {t(`library.sortOptions.${option.value}`, { defaultValue: option.label })}
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      </AnchoredPopover>
    </div>
  );
}

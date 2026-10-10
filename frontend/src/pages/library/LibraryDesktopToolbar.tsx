import type { TFunction } from "i18next";
import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  BookmarkPlus,
  CheckCircle2,
  Circle,
  Filter,
  Headphones,
  PauseCircle,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  X,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { listeningStatusOptions } from "@/features/work-detail/workDetailShared";
import { useDismissiblePopover } from "@/hooks/useDismissiblePopover";
import type { ListeningStatus, Work } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

import type { MobileLibrarySortProps } from "./MobileLibraryToolbar";
import { RecentlyPlayedPicker } from "./RecentlyPlayedPicker";

/**
 * The wide-layout Library header: the source tabs, the search field, and a row
 * of icon controls, followed by the active quick-mark filter. Phones use
 * `MobileLibraryToolbar` instead.
 */
export function LibraryDesktopToolbar({
  sourceTabs,
  searchQuery,
  onSearchChange,
  onAddClause,
  addClauseOpen,
  onOpenRecent,
  displayPicker,
  recommendationAction,
  sort,
  selectionToggle,
  statusFilter,
  onStatusFilterChange,
}: {
  sourceTabs: ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  onOpenRecent: (work: Work) => void;
  displayPicker: ReactNode;
  recommendationAction: ReactNode;
  sort: MobileLibrarySortProps;
  /** Set when the active view selects works instead of filtering by quick mark. */
  selectionToggle: ReactNode | null;
  statusFilter: ListeningStatus | "all";
  onStatusFilterChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  const activeFilterCount = statusFilter === "all" ? 0 : 1;
  return (
    <>
      <section className="flex flex-wrap items-center gap-2" data-toast-avoid>
        <div className="order-1 min-w-0 max-w-full">{sourceTabs}</div>
        <div className="search-field order-3 flex min-h-10 w-full items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:order-2 lg:w-auto lg:min-w-[14rem] lg:max-w-2xl lg:flex-1">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            value={searchQuery}
            onKeyDown={dismissKeyboardOnEnter}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
          />
          {searchQuery.trim() && (
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onSearchChange("")}
              aria-label={t("library.clearSearch")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={(event) => onAddClause(event.currentTarget)}
            aria-label={t("library.addSearchCondition")}
            aria-haspopup="dialog"
            aria-expanded={addClauseOpen}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="order-2 ml-auto flex flex-wrap justify-end gap-2 lg:order-3">
          <RecentlyPlayedPicker onOpen={onOpenRecent} />
          {displayPicker}
          {recommendationAction}
          <SortPicker {...sort} />
          {selectionToggle ?? (
            <FilterPicker value={statusFilter} activeCount={activeFilterCount} onChange={onStatusFilterChange} />
          )}
        </div>
      </section>
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="gap-1.5">
            <Filter className="h-4 w-4" />
            {t("library.markFilter")}: {statusFilterLabel(statusFilter, t)}
            <button
              className="rounded-sm text-muted-foreground hover:text-foreground"
              aria-label={t("library.clearMarkFilter")}
              onClick={() => onStatusFilterChange("all")}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}
    </>
  );
}

function SortPicker({ options, value, direction, onChange, onDirectionChange, onReshuffle }: MobileLibrarySortProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const label = options.find((option) => option.value === value)?.label ?? t("library.sort");
  const localizedLabel = t(`library.sortOptions.${value}`, { defaultValue: label });
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  const nextDirection = direction === "asc" ? "desc" : "asc";
  return (
    <div className="relative" ref={popoverRef}>
      <div className="inline-flex rounded-md border bg-background">
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={t("library.sortLabel", { label: localizedLabel })}
          aria-label={t("library.sortLabel", { label: localizedLabel })}
          onClick={() => setOpen((current) => !current)}
        >
          <ArrowUpDown className="h-4 w-4" />
        </button>
        <button
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-r-md border-l text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          title={
            value === "random"
              ? t("library.reshuffle")
              : direction === "asc"
                ? t("library.ascending")
                : t("library.descending")
          }
          aria-label={
            value === "random"
              ? t("library.reshuffle")
              : direction === "asc"
                ? t("library.ascending")
                : t("library.descending")
          }
          onClick={() => (value === "random" ? onReshuffle() : onDirectionChange(nextDirection))}
        >
          {value === "random" ? (
            <RefreshCw className="h-4 w-4" />
          ) : direction === "asc" ? (
            <ArrowDownAZ className="h-4 w-4" />
          ) : (
            <ArrowDownZA className="h-4 w-4" />
          )}
        </button>
      </div>
      <AnchoredPopover
        open={open}
        anchorRef={popoverRef}
        onOpenChange={setOpen}
        className="w-[min(11rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        {options.map((option) => (
          <button
            key={option.value}
            className={`flex min-h-10 w-full items-center rounded-md px-3 py-2 text-left hover:bg-muted ${value === option.value ? "bg-primary/10 font-medium text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
            aria-pressed={value === option.value}
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
          >
            {t(`library.sortOptions.${option.value}`, { defaultValue: option.label })}
          </button>
        ))}
      </AnchoredPopover>
    </div>
  );
}

function FilterPicker({
  value,
  activeCount,
  disabled = false,
  onChange,
}: {
  value: ListeningStatus | "all";
  activeCount: number;
  disabled?: boolean;
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissiblePopover(open, popoverRef, () => setOpen(false));
  return (
    <div className="relative" ref={popoverRef}>
      <IconButton
        title={
          disabled
            ? t("library.markFiltersUnavailable")
            : activeCount > 0
              ? t("library.activeFilters", { count: activeCount })
              : t("library.filters")
        }
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Filter className="h-4 w-4" />
        {activeCount > 0 && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" />}
      </IconButton>
      <AnchoredPopover
        open={open && !disabled}
        anchorRef={popoverRef}
        className="flex w-10 flex-col gap-1 rounded-lg border bg-card p-1 text-sm shadow-lg"
      >
        <button
          className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === "all" ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
          aria-pressed={value === "all"}
          title={t("library.allMarks")}
          aria-label={t("library.allMarks")}
          onClick={() => {
            onChange("all");
            setOpen(false);
          }}
        >
          <X className="h-4 w-4" />
        </button>
        {listeningStatusOptions.map((option) => {
          const meta = quickMarkFilterMeta(option.value);
          return (
            <button
              key={option.value}
              className={`flex h-8 items-center justify-center rounded-md hover:bg-muted ${value === option.value ? "bg-primary/10 text-primary ring-1 ring-inset ring-primary/15" : "text-muted-foreground"}`}
              aria-pressed={value === option.value}
              title={t(`library.status.${option.value}`, { defaultValue: option.label })}
              aria-label={t(`library.status.${option.value}`, { defaultValue: option.label })}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <meta.icon className={`h-4 w-4 ${value === option.value ? "" : meta.className}`} />
            </button>
          );
        })}
      </AnchoredPopover>
    </div>
  );
}

function quickMarkFilterMeta(value: ListeningStatus) {
  switch (value) {
    case "want_to_listen":
      return { icon: BookmarkPlus, className: "text-primary" };
    case "listening":
      return { icon: Headphones, className: "text-primary" };
    case "finished":
      return { icon: CheckCircle2, className: "text-success" };
    case "relisten":
      return { icon: Repeat2, className: "text-primary" };
    case "paused":
      return { icon: PauseCircle, className: "text-warning" };
    default:
      return { icon: Circle, className: "" };
  }
}

function statusFilterLabel(value: ListeningStatus | "all", t: TFunction) {
  if (value === "all") return t("library.allMarks");
  const fallback = listeningStatusOptions.find((option) => option.value === value)?.label ?? value;
  return t(`library.status.${value}`, { defaultValue: fallback });
}

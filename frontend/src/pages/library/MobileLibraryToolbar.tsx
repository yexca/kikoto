import { History, ListFilter, Plus, Search, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { quickMarkMeta } from "@/components/work-card/WorkCardShell";
import { listeningStatusOptions } from "@/features/work-detail/workDetailShared";
import { numberFormat } from "@/i18n/format";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/LocaleProvider";
import type { ListeningStatus, Work } from "@/lib/api";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

import { ContinueListeningRail } from "./ContinueListeningRail";
import { LibrarySortButton, type LibrarySortProps } from "./LibrarySortButton";

/**
 * The phone Library header: an always-visible search field with the source
 * menu beside it, then sort and view controls with two row toggles, one for
 * the Continue listening rail and one for the quick-mark filter chips, and a
 * result caption. Both rows start collapsed; the mark toggle shows an active
 * filter so a collapsed row never hides why results narrowed.
 */
export function MobileLibraryToolbar({
  sourceMenu,
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
  onOpenRecent,
}: {
  sourceMenu: ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  resultCount: number | null;
  /** Shown beside the count when the results span more than one page. */
  resultPage: { page: number; totalPages: number };
  sort: LibrarySortProps;
  actions: ReactNode;
  /** Null when the active view cannot filter by quick mark. */
  statusFilter: ListeningStatus | "all" | null;
  onStatusFilterChange: (value: ListeningStatus | "all") => void;
  onOpenRecent: (work: Work) => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const [markFilterOpen, setMarkFilterOpen] = useState(false);
  const markFilterId = useId();
  const [continueOpen, setContinueOpen] = useState(false);
  const continueId = useId();
  return (
    <div className="space-y-3" data-toast-avoid>
      <div className="flex min-w-0 items-center gap-2">
        <div className="search-field flex h-[var(--control-height)] min-w-0 flex-1 items-center gap-2 rounded-[var(--control-radius)] border bg-card pl-4 pr-1.5 text-sm shadow-sm transition-colors focus-within:border-primary/50">
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
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--badge-radius)] text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => onSearchChange("")}
              aria-label={t("library.clearSearch")}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-[var(--badge-radius)] bg-muted text-muted-foreground hover:text-foreground",
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
        {sourceMenu}
      </div>
      <div className="flex min-h-9 items-center gap-2">
        <LibrarySortButton {...sort} />
        {statusFilter !== null && (
          <MarkFilterToggle
            value={statusFilter}
            open={markFilterOpen}
            controls={markFilterId}
            onToggle={() => setMarkFilterOpen((open) => !open)}
          />
        )}
        <RowToggle
          label={t("library.continueListening")}
          open={continueOpen}
          controls={continueId}
          onToggle={() => setContinueOpen((open) => !open)}
        >
          <History className="h-4 w-4" aria-hidden="true" />
        </RowToggle>
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {continueOpen && <ContinueListeningRail id={continueId} onOpen={onOpenRecent} />}
      {statusFilter !== null && markFilterOpen && (
        <StatusChips id={markFilterId} value={statusFilter} onChange={onStatusFilterChange} />
      )}
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

function MarkFilterToggle({
  value,
  open,
  controls,
  onToggle,
}: {
  value: ListeningStatus | "all";
  open: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const active = value !== "all";
  const meta = active ? quickMarkMeta(value) : null;
  const Icon = meta?.icon ?? ListFilter;
  const label = active
    ? t("library.markFilterValue", { status: t(`library.status.${value}`) })
    : t("library.markFilterToggle");
  return (
    <RowToggle label={label} open={open} controls={controls} active={active} onToggle={onToggle}>
      <Icon className={cn("h-4 w-4", meta?.className)} aria-hidden="true" />
    </RowToggle>
  );
}

/** A sort-row button that shows or hides the row it controls; `active` marks a setting that applies while it is hidden. */
function RowToggle({
  label,
  open,
  controls,
  active = false,
  children,
  onToggle,
}: {
  label: string;
  open: boolean;
  controls: string;
  active?: boolean;
  children: ReactNode;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-sm"
      className={cn("shrink-0", active && "border-primary/30 bg-primary/10 aria-expanded:bg-primary/10")}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {children}
      {active && !open && (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary" aria-hidden="true" />
      )}
    </Button>
  );
}

function StatusChips({
  id,
  value,
  onChange,
}: {
  id: string;
  value: ListeningStatus | "all";
  onChange: (value: ListeningStatus | "all") => void;
}) {
  const { t } = useTranslation();
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--badge-radius)] border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "border-primary/30 bg-primary/10 text-primary"
        : "border-border bg-card text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      id={id}
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

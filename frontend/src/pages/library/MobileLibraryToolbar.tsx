import { Plus, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SearchToggle, useCollapsibleSearch } from "@/components/collection/CollapsibleSearch";
import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

/**
 * The phone Library header: the source menu with the result caption, then
 * Search, Recently played, and View as icons on one row; below it, what shapes
 * the results, the labeled order with its reshuffle and the Quick mark filter.
 * The search field opens from its icon above both rows and stays open while
 * the query holds text or search conditions. The order's name truncates
 * before its row overflows.
 */
export function MobileLibraryToolbar({
  sourceMenu,
  searchQuery,
  onSearchChange,
  onAddClause,
  addClauseOpen,
  resultCount,
  resultPage,
  resultControls,
  viewControls,
}: {
  sourceMenu: ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  resultCount: number | null;
  /** Shown under the count when the results span more than one page. */
  resultPage: { page: number; totalPages: number };
  /** The order and, where the view offers it, the Quick mark filter. */
  resultControls: ReactNode;
  /** Recently played and View. */
  viewControls: ReactNode;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const search = useCollapsibleSearch(searchQuery, onSearchChange);
  const format = numberFormat(resolvedLocale);
  const pageText =
    resultPage.totalPages > 1
      ? t("library.resultPage", {
          page: format.format(resultPage.page),
          totalPages: format.format(resultPage.totalPages),
        })
      : "";
  return (
    <div className="space-y-3" data-toast-avoid>
      {search.open && (
        <div
          ref={search.fieldRef}
          className="search-field flex h-[var(--control-height)] min-w-0 items-center gap-2 rounded-[var(--control-radius)] border bg-card pl-4 pr-1.5 text-sm shadow-sm transition-colors focus-within:border-primary/50"
        >
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
      )}
      <div className="flex min-w-0 items-center gap-2">
        {sourceMenu}
        {/* The caption shares the source row; a long page count gives way before the icons. */}
        <p className="flex min-w-0 flex-1 flex-col text-xs leading-4 text-muted-foreground">
          {resultCount !== null && (
            <>
              <span className="truncate font-semibold text-foreground">
                {t("library.resultCount", { value: format.format(resultCount) })}
              </span>
              {pageText && <span className="truncate tabular-nums">{pageText}</span>}
            </>
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <SearchToggle open={search.open} onToggle={search.toggle} />
          {viewControls}
        </div>
      </div>
      <div className="flex min-h-8 min-w-0 items-center gap-2">{resultControls}</div>
    </div>
  );
}

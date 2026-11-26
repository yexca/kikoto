import { Plus, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PageHeaderTitle } from "@/components/pageHeader";
import { SearchToggle, useCollapsibleSearch } from "@/components/collection/CollapsibleSearch";
import { numberFormat } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

import { LibrarySourceMenu, type LibrarySourceProps } from "./LibraryPrimaryTabs";

/**
 * The phone Library controls. The source menu and, after it, the result count
 * and page sit in the app header beside the app icon; the toolbar keeps one
 * row: the labeled order with its reshuffle and the Quick mark filter, then
 * Search, Recently played, and View as icons. The search field opens from its
 * icon above the row and stays open while the query holds text or search
 * conditions. The order's name truncates before the row overflows.
 */
export function MobileLibraryToolbar({
  source,
  searchQuery,
  onSearchChange,
  onAddClause,
  addClauseOpen,
  resultCount,
  resultPage,
  resultControls,
  viewControls,
}: {
  source: LibrarySourceProps;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  resultCount: number | null;
  /** Shown after the count when the results span more than one page. */
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
  const paged = resultPage.totalPages > 1;
  const page = format.format(resultPage.page);
  const totalPages = format.format(resultPage.totalPages);
  return (
    <div className="space-y-3" data-toast-avoid>
      <PageHeaderTitle>
        <LibrarySourceMenu {...source} />
        {/* The source name truncates before the count and page do. */}
        <p className="flex shrink-0 flex-col text-xs leading-4 text-muted-foreground">
          {resultCount !== null && (
            <>
              <span className="truncate">{t("library.resultCount", { value: format.format(resultCount) })}</span>
              {paged && (
                // The header shows the short page/total; assistive tech reads the full phrase.
                // The span is positioned so the screen-reader text cannot escape its clipping.
                <span className="relative truncate tabular-nums">
                  <span aria-hidden="true">{`${page}/${totalPages}`}</span>
                  <span className="sr-only">{t("library.resultPage", { page, totalPages })}</span>
                </span>
              )}
            </>
          )}
        </p>
      </PageHeaderTitle>
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
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{resultControls}</div>
        <div className="flex shrink-0 items-center gap-2">
          <SearchToggle open={search.open} onToggle={search.toggle} />
          {viewControls}
        </div>
      </div>
    </div>
  );
}

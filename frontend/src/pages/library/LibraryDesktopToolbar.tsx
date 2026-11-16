import { Plus, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { dismissKeyboardOnEnter } from "@/lib/keyboard";

/**
 * The wide-layout Library header: the source tabs, the search field with its
 * condition builder, and the browse controls at the row's end (the order, the
 * Quick mark filter, Recently played, and View). Below the wide breakpoint
 * the search field takes a full row under the tabs and controls. Phones use
 * `MobileLibraryToolbar` instead.
 */
export function LibraryDesktopToolbar({
  sourceTabs,
  searchQuery,
  onSearchChange,
  onAddClause,
  addClauseOpen,
  controls,
}: {
  sourceTabs: ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onAddClause: (anchor: HTMLElement) => void;
  addClauseOpen: boolean;
  controls: ReactNode;
}) {
  const { t } = useTranslation();
  return (
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
      <div className="order-2 ml-auto flex flex-wrap items-center justify-end gap-2 lg:order-3">{controls}</div>
    </section>
  );
}

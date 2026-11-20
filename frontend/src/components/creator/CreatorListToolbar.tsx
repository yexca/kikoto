import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SearchToggle, useCollapsibleSearch } from "@/components/collection/CollapsibleSearch";
import { CollectionFilterChips } from "@/components/collection/CollectionFilterChips";
import type { CollectionFilterOption } from "@/components/collection/CollectionFilterPicker";
import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";
import { cn } from "@/lib/tailwindClassNames";

export type CreatorListToolbarFilterOption<Value extends string> = CollectionFilterOption<Value>;

/**
 * Search, view chips, and page size for a creator list. A phone puts the
 * sideways-scrolling chip strip and, at its end, Search and page size on one
 * row; Search opens its field above the row and keeps it while it holds a
 * query. Wider layouts put the field, chips, and page size on one row.
 */
export function CreatorListToolbar<FilterValue extends string>({
  label,
  query,
  placeholder,
  filter,
  filterOptions,
  pageSize,
  pageSizeOptions,
  onQueryChange,
  onFilterChange,
  onPageSizeChange,
}: {
  label: string;
  query: string;
  placeholder: string;
  filter: FilterValue;
  filterOptions: readonly CreatorListToolbarFilterOption<FilterValue>[];
  pageSize: number;
  pageSizeOptions: readonly number[];
  onQueryChange: (value: string) => void;
  onFilterChange: (value: FilterValue) => void;
  onPageSizeChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const search = useCollapsibleSearch(query, onQueryChange);

  return (
    <section className="flex flex-wrap items-center gap-x-3 gap-y-2.5" data-toast-avoid>
      <div
        ref={search.fieldRef}
        className={cn(
          "search-field order-1 min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:flex lg:w-72 lg:flex-none xl:w-80",
          search.open ? "flex" : "hidden",
        )}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          value={query}
          onKeyDown={dismissKeyboardOnEnter}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        {query.trim() && (
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange("")}
            aria-label={t("collection.clearSearch")}
            title={t("collection.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <CollectionFilterChips
        label={t("collection.filters", { label })}
        value={filter}
        options={filterOptions}
        onChange={onFilterChange}
        className="relative order-2 -ml-4 min-w-0 flex-1 pl-4 lg:ml-0 lg:pl-0"
      />
      <div className="order-3 flex shrink-0 items-center gap-2 lg:ml-auto">
        <div className="lg:hidden">
          <SearchToggle open={search.open} onToggle={search.toggle} />
        </div>
        <PageSizePicker value={pageSize} options={pageSizeOptions} onChange={onPageSizeChange} />
      </div>
    </section>
  );
}

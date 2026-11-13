import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { CollectionFilterPicker, type CollectionFilterOption } from "@/components/collection/CollectionFilterPicker";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

/**
 * The toolbar of one circle or voice actor's works, holding at most five
 * controls: optional view tabs, the search field, the order, the availability
 * filter, and one View entry for everything else (display options and
 * selection). Wide layouts keep them on one row. A phone puts the tabs on
 * their own row, the search field full width below, and then the result
 * caption with the order, filter, and View at its end.
 */
export function CatalogWorkToolbar<FilterValue extends string>({
  leading,
  query,
  searchLabel,
  onQueryChange,
  sort,
  filterLabel,
  filter,
  defaultFilter,
  filterOptions,
  onFilterChange,
  view,
  mobileCaption,
}: {
  leading?: ReactNode;
  query: string;
  searchLabel: string;
  onQueryChange: (value: string) => void;
  /** The order control; absent where the view lists no works to order. */
  sort?: ReactNode;
  filterLabel: string;
  filter: FilterValue;
  defaultFilter: FilterValue;
  filterOptions: readonly CollectionFilterOption<FilterValue>[];
  onFilterChange: (value: FilterValue) => void;
  /** The View entry. */
  view: ReactNode;
  /** The result caption a phone shows before the controls. */
  mobileCaption?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-wrap items-center gap-x-2 gap-y-3" data-toast-avoid>
      {leading && <div className="w-full min-w-0 max-w-full lg:w-auto">{leading}</div>}
      <div className="search-field flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-sm lg:w-auto lg:min-w-[14rem] lg:max-w-xl lg:flex-1">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          enterKeyHint="search"
          value={query}
          onKeyDown={dismissKeyboardOnEnter}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
        />
        {query.trim() && (
          <button
            type="button"
            className="touch-target grid h-8 w-8 shrink-0 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onQueryChange("")}
            aria-label={t("collection.clearSearch")}
            title={t("collection.clearSearch")}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {mobileCaption && <div className="min-w-0 flex-1 lg:hidden">{mobileCaption}</div>}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {sort}
        <CollectionFilterPicker
          label={filterLabel}
          value={filter}
          defaultValue={defaultFilter}
          options={filterOptions}
          onChange={onFilterChange}
        />
        {view}
      </div>
    </section>
  );
}

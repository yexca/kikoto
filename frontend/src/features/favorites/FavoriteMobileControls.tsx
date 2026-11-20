import type { ReactNode } from "react";

import { SearchToggle, useCollapsibleSearch } from "@/components/collection/CollapsibleSearch";
import type { FavoriteStatusFilterOption } from "./favoriteShelfModel";
import type { FavoriteStatusFilter } from "./favoritesBrowseState";
import { FavoriteStatusChips } from "./FavoriteStatusChips";
import { FavoriteSearchInput } from "./FavoriteWorksControls";

/**
 * The phone shelf controls: a row that leads with the labeled sort and keeps
 * search, the filter, and the view utilities at its end, then the Quick mark
 * chips as one scrollable row. The search field opens from its icon above the
 * row and stays open while it holds a query.
 */
export function FavoriteMobileControls({
  query,
  placeholder,
  onQueryChange,
  sort,
  actions,
  status,
}: {
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  sort: ReactNode;
  actions: ReactNode;
  status: {
    options: FavoriteStatusFilterOption[];
    value: FavoriteStatusFilter;
    onChange: (value: FavoriteStatusFilter) => void;
  };
}) {
  const search = useCollapsibleSearch(query, onQueryChange);

  return (
    <div className="space-y-2" data-toast-avoid>
      {search.open && (
        <div ref={search.fieldRef}>
          <FavoriteSearchInput
            value={query}
            placeholder={placeholder}
            onChange={onQueryChange}
            className="h-[var(--control-height)] w-full shadow-sm"
          />
        </div>
      )}
      <div className="flex min-h-11 items-center gap-1.5">
        {sort}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <SearchToggle open={search.open} onToggle={search.toggle} />
          {actions}
        </div>
      </div>
      <FavoriteStatusChips {...status} />
    </div>
  );
}

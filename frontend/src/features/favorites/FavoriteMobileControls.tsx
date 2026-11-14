import type { ReactNode } from "react";

import { FavoriteSearchInput } from "./FavoriteWorksControls";

/**
 * The phone shelf controls, in the order of the phone Library toolbar: an
 * always-visible search field, then a row that leads with the labeled sort and
 * keeps the filter and view utilities at its end. The shelf header above
 * states the result count and page in place of a top pager.
 */
export function FavoriteMobileControls({
  query,
  placeholder,
  onQueryChange,
  sort,
  actions,
}: {
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  /** Null on creator shelves, which only search. */
  sort: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="space-y-2" data-toast-avoid>
      <FavoriteSearchInput
        value={query}
        placeholder={placeholder}
        onChange={onQueryChange}
        className="h-[var(--control-height)] w-full shadow-sm"
      />
      {sort && (
        <div className="flex min-h-11 items-center gap-1.5">
          {sort}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
        </div>
      )}
    </div>
  );
}

import { Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
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
  const { t } = useTranslation();
  const hasQuery = Boolean(query.trim());
  const [searchOpen, setSearchOpen] = useState(hasQuery);
  const focusSearch = useRef(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  // A query restored from history or typed elsewhere keeps the field on show.
  useEffect(() => {
    if (hasQuery) setSearchOpen(true);
  }, [hasQuery]);

  useEffect(() => {
    if (!searchOpen || !focusSearch.current) return;
    focusSearch.current = false;
    fieldRef.current?.querySelector("input")?.focus();
  }, [searchOpen]);

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false);
      if (hasQuery) onQueryChange("");
      return;
    }
    focusSearch.current = true;
    setSearchOpen(true);
  };

  return (
    <div className="space-y-2" data-toast-avoid>
      {searchOpen && (
        <div ref={fieldRef}>
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
          <IconButton title={t("favorites.search")} aria-pressed={searchOpen} onClick={toggleSearch}>
            <Search className={`h-4 w-4 ${searchOpen ? "text-primary" : ""}`} />
          </IconButton>
          {actions}
        </div>
      </div>
      <FavoriteStatusChips {...status} />
    </div>
  );
}

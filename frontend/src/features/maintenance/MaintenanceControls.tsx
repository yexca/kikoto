import { RefreshCw, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { PageSizePicker } from "@/components/collection/PageSizePicker";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useStableCallback } from "@/hooks/useStableCallback";
import { dismissKeyboardOnEnter } from "@/lib/keyboard";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Live search state for the Metadata record tables: the draft follows the
 * input, and the committed query settles after a short pause or on Enter.
 * `onCommit` runs in the same update as a changed query so callers can reset
 * paging without an extra request.
 */
export function useMaintenanceSearch(onCommit: () => void) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const committed = useRef("");
  const notifyCommit = useStableCallback(onCommit);

  const commit = (value: string) => {
    const next = value.trim();
    if (next === committed.current) return;
    committed.current = next;
    setQuery(next);
    notifyCommit();
  };

  useEffect(() => {
    if (draft.trim() === query) return;
    const timer = window.setTimeout(() => commit(draft), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, query]);

  return {
    draft,
    query,
    setDraft,
    commit: () => commit(draft),
    clear: () => {
      setDraft("");
      commit("");
    },
  };
}

/**
 * Where the Metadata page header lets a view place its toolbar. The page
 * measures the header row and decides whether the search field fits beside
 * the tabs (`search` is then an inline slot) or collapses behind an icon and
 * opens on its own row below the header.
 */
export type MaintenanceToolbarSlots = {
  actions: HTMLElement | null;
  search: HTMLElement | null;
  compactSearch: boolean;
};

/**
 * Library-style toolbar for the Metadata record tables, rendered into the page
 * header: a live search field plus quiet refresh and page-size controls, with
 * view-specific actions (`children`) after them.
 */
export function MaintenanceToolbar({
  slots,
  query,
  label,
  placeholder,
  loading,
  pageSize,
  pageSizeOptions,
  children,
  onQueryChange,
  onQueryCommit,
  onClear,
  onRefresh,
  onPageSizeChange,
}: {
  slots: MaintenanceToolbarSlots;
  query: string;
  label: string;
  placeholder: string;
  loading: boolean;
  pageSize: number;
  pageSizeOptions: readonly number[];
  children?: ReactNode;
  onQueryChange: (value: string) => void;
  onQueryCommit: () => void;
  onClear: () => void;
  onRefresh: () => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { t } = useTranslation();
  const searchId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(() => Boolean(query.trim()));
  const focusOnOpen = useRef(false);
  const showSearch = !slots.compactSearch || searchOpen || Boolean(query.trim());

  useEffect(() => {
    if (!showSearch || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    inputRef.current?.focus();
  }, [showSearch]);

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) onQueryCommit();
    dismissKeyboardOnEnter(event);
  };
  const toggleSearch = () => {
    if (query.trim()) {
      inputRef.current?.focus();
      return;
    }
    focusOnOpen.current = !searchOpen;
    setSearchOpen((current) => !current);
  };

  const searchField = (
    <div
      id={searchId}
      className={`search-field flex min-h-10 min-w-0 items-center gap-2 rounded-lg border bg-card px-3 text-sm ${
        slots.compactSearch ? "w-full" : "min-w-[12rem] max-w-2xl flex-1"
      }`}
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        maxLength={256}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={submitOnEnter}
        placeholder={placeholder}
        aria-label={label}
      />
      {query && (
        <button
          type="button"
          className="touch-target relative text-muted-foreground hover:text-foreground"
          onClick={onClear}
          aria-label={t("unlinked.clearSearch")}
          title={t("unlinked.clearSearch")}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
  const actions = (
    <>
      {slots.compactSearch && (
        <Button
          type="button"
          variant="toolbar"
          size="icon-sm"
          data-search-toggle
          title={label}
          aria-label={label}
          aria-expanded={showSearch}
          aria-controls={showSearch ? searchId : undefined}
          onClick={toggleSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      )}
      <IconButton title={t("unlinked.refresh")} disabled={loading} onClick={onRefresh}>
        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </IconButton>
      <PageSizePicker value={pageSize} options={pageSizeOptions} onChange={onPageSizeChange} />
      {children}
    </>
  );
  return (
    <>
      {slots.search && showSearch && createPortal(searchField, slots.search)}
      {slots.actions && createPortal(actions, slots.actions)}
    </>
  );
}

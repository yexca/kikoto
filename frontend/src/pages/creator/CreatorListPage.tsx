import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { BrowseLoadingIndicator } from "@/components/collection/BrowseLoadingIndicator";
import { CollectionPagination } from "@/components/collection/CollectionPagination";
import {
  CreatorCollectionSkeleton,
  creatorCardMinHeightClassName,
  creatorCollectionClassName,
} from "@/components/creator/CreatorCard";
import { CreatorListToolbar } from "@/components/creator/CreatorListToolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/useStableCallback";
import { useBrowseHistoryState } from "@/hooks/useBrowseHistoryState";
import { currentInternalLocation } from "@/lib/browserHistory";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { creatorBrowseSearch, creatorBrowseStateFromSearch } from "@/pages/creatorBrowseState";

export type CreatorListRequest<Filter extends string> = {
  page: number;
  pageSize: number;
  query: string;
  filter: Filter;
  signal: AbortSignal;
};

type CreatorListItem = { favorite: boolean };

export type CreatorListCardHandlers<Item> = {
  onFavoriteToggle: (item: Item) => Promise<void>;
  onTagsSave: (item: Item, tags: string[]) => Promise<void>;
};

/**
 * The circle and voice actor lists: URL-backed search, filter, and paging, one
 * request per distinct query, and optimistic favorite and tag edits.
 */
export function CreatorListPage<Item extends CreatorListItem, Filter extends string>({
  active,
  path,
  filters,
  filterOptions,
  pageSizeOptions,
  isListLocation,
  writeLastListLocation,
  load,
  itemKey,
  toggleFavorite,
  saveTags,
  renderItem,
  unfilteredEmptyMessage,
  copy,
}: {
  active: boolean;
  path: string;
  filters: readonly Filter[];
  filterOptions: readonly { value: Filter; label: string }[];
  pageSizeOptions: readonly number[];
  isListLocation: (location: string) => boolean;
  writeLastListLocation: (storageScope: string, location: string) => void;
  load: (request: CreatorListRequest<Filter>) => Promise<{ items: Item[]; total: number; page: number }>;
  itemKey: (item: Item) => string | number;
  /** Returns the fields the server changed after flipping the favorite. */
  toggleFavorite: (item: Item) => Promise<Partial<Item>>;
  saveTags: (item: Item, tags: string[]) => Promise<Partial<Item>>;
  renderItem: (item: Item, handlers: CreatorListCardHandlers<Item>) => ReactNode;
  /** Shown when the unfiltered list is empty, e.g. before any metadata sync. */
  unfilteredEmptyMessage?: string;
  copy: {
    label: string;
    searchPlaceholder: string;
    loading: string;
    refreshing: string;
    results: string;
    empty: string;
    pages: string;
  };
}) {
  const { t } = useTranslation();
  const auth = useAuth();
  const toast = useToast();
  const storageScope = currentClientStorageScope(auth.user?.id ?? null);
  const readBrowseState = () =>
    creatorBrowseStateFromSearch(
      window.location.search,
      { query: "", filter: "all" as Filter, tag: "", page: 1, pageSize: 24 },
      filters,
      pageSizeOptions,
    );
  const [initialBrowseState] = useState(() => readBrowseState());
  const [items, setItems] = useState<Item[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState(initialBrowseState.query);
  const [requestQuery, setRequestQuery] = useState(initialBrowseState.query);
  const [filter, setFilter] = useState<Filter>(initialBrowseState.filter);
  const [page, setPage] = useState(initialBrowseState.page);
  const [pageSize, setPageSize] = useState(initialBrowseState.pageSize);
  const [total, setTotal] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRequestKey = useRef("");
  const loadItems = useStableCallback(load);
  const emptyMessage = useStableCallback(() => unfilteredEmptyMessage ?? "");
  const notifyLoadFailure = useStableCallback((error: unknown) => {
    setLoadError(t("errors.unavailable"));
    toast.notify(toastFromError(error, t("errors.unavailable")));
  });
  const hasPendingRestoration = useBrowseHistoryState({
    active,
    stateKey: creatorBrowseSearch({ query, filter, tag: "", page, pageSize }),
    read: readBrowseState,
    keyOf: (state) => creatorBrowseSearch({ ...state, tag: "" }),
    isCurrentLocation: () => isListLocation(currentInternalLocation()),
    restore: (state) => {
      setQuery(state.query);
      setRequestQuery(state.query);
      setFilter(state.filter);
      setPage(state.page);
      setPageSize(state.pageSize);
    },
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setRequestQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!active || hasPendingRestoration() || !isListLocation(currentInternalLocation())) return;
    const location = `${path}${creatorBrowseSearch({ query, filter, tag: "", page, pageSize })}`;
    window.history.replaceState(window.history.state ?? {}, "", location);
    writeLastListLocation(storageScope, location);
  }, [
    active,
    filter,
    hasPendingRestoration,
    isListLocation,
    page,
    pageSize,
    path,
    query,
    storageScope,
    writeLastListLocation,
  ]);

  useEffect(() => {
    if (!active || hasPendingRestoration()) return;
    const requestKey = JSON.stringify([page, pageSize, requestQuery, filter, reloadToken]);
    if (loadedRequestKey.current === requestKey) {
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    setLoadError("");
    loadItems({ page, pageSize, query: requestQuery, filter, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        loadedRequestKey.current = requestKey;
        setItems(result.items);
        setTotal(result.total);
        setHasLoaded(true);
        setMessage(result.total === 0 && !requestQuery.trim() && filter === "all" ? emptyMessage() : "");
        if (result.page !== page) setPage(result.page);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        notifyLoadFailure(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [
    active,
    emptyMessage,
    filter,
    hasPendingRestoration,
    loadItems,
    notifyLoadFailure,
    page,
    pageSize,
    reloadToken,
    requestQuery,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const changeFilter = (value: Filter) => {
    setFilter(value);
    setPage(1);
  };
  const changePageSize = (value: number) => {
    setPageSize(value);
    setPage(1);
  };
  const paginationProps = {
    page,
    pageSize,
    totalItems: total,
    totalPages,
    itemLabel: copy.label,
    ariaLabel: copy.pages,
    compactMobile: true,
    compactTop: true,
    refreshing: isLoading && hasLoaded,
    refreshingLabel: copy.refreshing,
    onPageChange: setPage,
  };

  const updateItem = (item: Item, patch: Partial<Item>) => {
    const key = itemKey(item);
    setItems((current) => current.map((entry) => (itemKey(entry) === key ? { ...entry, ...item, ...patch } : entry)));
    // A filtered list may no longer include the edited item.
    if (filter !== "all" || requestQuery.trim()) setReloadToken((value) => value + 1);
  };
  const onFavoriteToggle = useStableCallback(async (item: Item) => {
    try {
      updateItem(item, await toggleFavorite(item));
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.favoriteUpdateFailed")));
    }
  });
  const onTagsSave = useStableCallback(async (item: Item, tags: string[]) => {
    try {
      updateItem(item, await saveTags(item, tags));
    } catch (error) {
      toast.notify(toastFromError(error, t("creatorBrowse.tagsUpdateFailed")));
    }
  });
  const handlers = useMemo(() => ({ onFavoriteToggle, onTagsSave }), [onFavoriteToggle, onTagsSave]);

  return (
    <div className="relative space-y-5">
      {message && <div className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{message}</div>}

      <section className="space-y-3">
        <CreatorListToolbar
          label={copy.label}
          query={query}
          placeholder={copy.searchPlaceholder}
          filter={filter}
          defaultFilter={"all" as Filter}
          filterOptions={filterOptions}
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          onQueryChange={setQuery}
          onFilterChange={changeFilter}
          onPageSizeChange={changePageSize}
        />
        <CollectionPagination {...paginationProps} placement="top" />

        {isLoading && !hasLoaded ? (
          <CreatorCollectionSkeleton label={copy.loading} />
        ) : !hasLoaded && loadError ? (
          <Card className={creatorCardMinHeightClassName} role="alert">
            <CardContent
              className={`grid ${creatorCardMinHeightClassName} place-items-center gap-3 p-5 text-center text-sm text-destructive`}
            >
              <span>{loadError}</span>
              <Button size="sm" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
                {t("creatorBrowse.retry")}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className={creatorCollectionClassName} role="region" aria-label={copy.results} aria-busy={isLoading}>
            {items.length > 0 ? (
              items.map((item) => <Fragment key={itemKey(item)}>{renderItem(item, handlers)}</Fragment>)
            ) : (
              <Card className={creatorCardMinHeightClassName}>
                <CardContent
                  className={`grid ${creatorCardMinHeightClassName} place-items-center p-5 text-sm text-muted-foreground`}
                >
                  {copy.empty}
                </CardContent>
              </Card>
            )}
          </div>
        )}
        <CollectionPagination {...paginationProps} placement="bottom" />
      </section>
      <BrowseLoadingIndicator refreshing={isLoading && hasLoaded} label={copy.refreshing} />
    </div>
  );
}

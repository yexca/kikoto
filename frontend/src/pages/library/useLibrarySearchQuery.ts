import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { compileLibrarySearchQuery, formatRemoteSearchQuery, parseSearchClauses } from "@/lib/librarySearchClauses";
import { defaultRemoteSourceViewState, type RemoteSourceViewState } from "@/pages/library/libraryBrowseModel";
import type { LibraryTab } from "@/pages/library/libraryRoutes";

const librarySearchDebounceMs = 400;

const remoteSearchDebounceMs = 600;

/**
 * The Library search field and the queries it settles into. Local and remote
 * requests settle on their own delays; a settled change returns the results
 * to their first page and queues a scroll to them.
 */
export function useLibrarySearchQuery({
  initialQuery,
  activeTab,
  queueResultsScroll,
  setWorkPage,
  setRemoteSourceStates,
}: {
  initialQuery: string;
  activeTab: LibraryTab;
  queueResultsScroll: () => void;
  setWorkPage: Dispatch<SetStateAction<number>>;
  setRemoteSourceStates: Dispatch<SetStateAction<Record<number, RemoteSourceViewState>>>;
}) {
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(initialQuery);
  const [debouncedRemoteSearchQuery, setDebouncedRemoteSearchQuery] = useState(initialQuery);
  const searchClauses = useMemo(() => parseSearchClauses(searchQuery), [searchQuery]);
  const debouncedSearchClauses = useMemo(() => parseSearchClauses(debouncedSearchQuery), [debouncedSearchQuery]);
  const debouncedRemoteSearchClauses = useMemo(
    () => parseSearchClauses(debouncedRemoteSearchQuery),
    [debouncedRemoteSearchQuery],
  );
  const remoteSearchQuery = useMemo(
    () => formatRemoteSearchQuery(debouncedRemoteSearchClauses),
    [debouncedRemoteSearchClauses],
  );
  const librarySearchQuery = useMemo(() => compileLibrarySearchQuery(debouncedSearchClauses), [debouncedSearchClauses]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery !== debouncedSearchQuery) {
        queueResultsScroll();
        if (activeTab.kind !== "source") setWorkPage(1);
      }
      setDebouncedSearchQuery(searchQuery);
    }, librarySearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [activeTab.kind, queueResultsScroll, searchQuery, debouncedSearchQuery, setWorkPage]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchQuery !== debouncedRemoteSearchQuery) {
        queueResultsScroll();
        if (activeTab.kind === "source") {
          setRemoteSourceStates((states) => ({
            ...states,
            [activeTab.source.id]: {
              ...(states[activeTab.source.id] ?? defaultRemoteSourceViewState),
              page: 1,
            },
          }));
        }
      }
      setDebouncedRemoteSearchQuery(searchQuery);
    }, remoteSearchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [activeTab, queueResultsScroll, searchQuery, debouncedRemoteSearchQuery, setRemoteSourceStates]);

  return {
    searchQuery,
    setSearchQuery,
    searchClauses,
    librarySearchQuery,
    remoteSearchQuery,
    /** Sets the field and both settled queries at once, skipping the delay. */
    settleSearchQuery: (query: string) => {
      setSearchQuery(query);
      setDebouncedSearchQuery(query);
      setDebouncedRemoteSearchQuery(query);
    },
  };
}

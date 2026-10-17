import { useEffect } from "react";

import type { LibrarySort, LibrarySource, SortDirection } from "@/lib/api";
import { currentInternalLocation, historyEntryKey } from "@/lib/browserHistory";
import {
  libraryBrowseSearch,
  type LibraryBrowseState,
  writeLastLibraryLocation,
  writeLibraryBrowseState,
  writeLibrarySortPreference,
} from "@/lib/libraryBrowseState";
import { writeLibraryHistoryBrowseState } from "@/pages/library/libraryBrowseModel";
import {
  knownLibraryRoute,
  libraryBrowseKey,
  type LibraryTab,
  type LocalLibraryScope,
  pathForActiveLibrary,
} from "@/pages/library/libraryRoutes";

/**
 * Keeps the shown Library browse state in storage, the URL, and the history
 * entry, and remembers the list's scroll offset while it is visible. Nothing
 * is written before the route and its saved controls are restored.
 */
export function useLibraryBrowsePersistence({
  active,
  browseHydrated,
  hasPendingBrowseRestore,
  showBrowse,
  browseSurfaceActive,
  sources,
  sourceRoutesReady,
  activeBrowseState,
  activeTab,
  localScope,
  browseStorageScope,
  librarySort,
  sortDirection,
}: {
  active: boolean;
  browseHydrated: boolean;
  hasPendingBrowseRestore: () => boolean;
  showBrowse: boolean;
  /** Whether the list is still the surface on screen when an effect cleans up. */
  browseSurfaceActive: () => boolean;
  sources: LibrarySource[];
  sourceRoutesReady: boolean;
  activeBrowseState: LibraryBrowseState;
  activeTab: LibraryTab;
  localScope: LocalLibraryScope;
  browseStorageScope: string;
  librarySort: LibrarySort;
  sortDirection: SortDirection;
}) {
  useEffect(() => {
    if (
      !active ||
      !browseHydrated ||
      hasPendingBrowseRestore() ||
      !showBrowse ||
      !knownLibraryRoute(window.location.pathname, window.location.search, sources)
    )
      return;
    const browseState = { ...activeBrowseState, scrollY: window.scrollY };
    writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
    writeLibrarySortPreference(libraryBrowseKey(activeTab, localScope, browseStorageScope), librarySort, sortDirection);
    const nextSearch = libraryBrowseSearch(activeBrowseState);
    if (sourceRoutesReady) {
      writeLastLibraryLocation(browseStorageScope, `${pathForActiveLibrary(activeTab, localScope)}${nextSearch}`);
    }
    window.history.replaceState(
      {
        ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
        libraryBrowseScope: browseStorageScope,
        libraryBrowseState: browseState,
      },
      "",
      `${window.location.pathname}${nextSearch}`,
    );
  }, [
    active,
    activeBrowseState,
    activeTab,
    browseHydrated,
    hasPendingBrowseRestore,
    browseStorageScope,
    librarySort,
    localScope,
    showBrowse,
    sortDirection,
    sourceRoutesReady,
    sources,
  ]);

  useEffect(() => {
    // Initial local defaults must not become a remote route's history snapshot
    // before its source and saved browse controls have been restored.
    if (
      !active ||
      !browseHydrated ||
      hasPendingBrowseRestore() ||
      !showBrowse ||
      !knownLibraryRoute(window.location.pathname, window.location.search, sources)
    )
      return;
    let pendingWrite: number | null = null;
    // Cleanup runs after another workspace has replaced this one in the shared
    // window scroll, so persist the last offset observed while this list was visible.
    let lastScrollY = window.scrollY;
    const entryKey = historyEntryKey(window.history.state);
    const location = currentInternalLocation();
    const flushScroll = () => {
      if (pendingWrite !== null) window.clearTimeout(pendingWrite);
      pendingWrite = null;
      if (historyEntryKey(window.history.state) !== entryKey || currentInternalLocation() !== location) return;
      const browseState = { ...activeBrowseState, scrollY: lastScrollY };
      writeLibraryBrowseState(libraryBrowseKey(activeTab, localScope, browseStorageScope), browseState);
      writeLibraryHistoryBrowseState(browseStorageScope, browseState);
    };
    const rememberScroll = () => {
      lastScrollY = window.scrollY;
      if (pendingWrite !== null) return;
      pendingWrite = window.setTimeout(flushScroll, 150);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushScroll();
    };
    window.addEventListener("scroll", rememberScroll, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("scroll", rememberScroll);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pendingWrite !== null) {
        window.clearTimeout(pendingWrite);
        pendingWrite = null;
      }
      if (browseSurfaceActive()) flushScroll();
    };
  }, [
    active,
    activeBrowseState,
    activeTab,
    browseHydrated,
    browseStorageScope,
    browseSurfaceActive,
    hasPendingBrowseRestore,
    localScope,
    showBrowse,
    sources,
  ]);
}

import { useEffect, useState } from "react";

import { api, type LibrarySource } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";
import { localBrowseRoute } from "@/pages/library/libraryRoutes";

/**
 * The remote sources the Library can browse, read while the page is active
 * until they load. A local route browses at once; a source route waits for the
 * sources before it is hydrated. `onLoaded` resolves the current route against
 * the loaded sources.
 */
export function useLibrarySources({
  active,
  authLoading,
  onLoaded,
}: {
  active: boolean;
  authLoading: boolean;
  onLoaded: (sources: LibrarySource[]) => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourceRoutesReady, setSourceRoutesReady] = useState(false);
  const [browseHydrated, setBrowseHydrated] = useState(() => localBrowseRoute(window.location.pathname));

  useEffect(() => {
    if (!active || authLoading || sourceRoutesReady) return;
    if (!localBrowseRoute(window.location.pathname)) setBrowseHydrated(false);
    setSourceRoutesReady(false);
    return startLoad((signal) => api.listLibrarySources(signal), {
      onSuccess: (items) => {
        setSources(items);
        setSourceRoutesReady(true);
        onLoaded(items);
      },
      onError: () => {
        setSources([]);
        setSourceRoutesReady(false);
      },
      onSettled: () => setBrowseHydrated(true),
    });
  }, [active, authLoading, onLoaded, sourceRoutesReady]);

  return { sources, sourceRoutesReady, browseHydrated };
}

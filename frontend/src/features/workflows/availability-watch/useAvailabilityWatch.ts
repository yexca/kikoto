import { useCallback, useEffect, useRef, useState } from "react";

import { workflowCopy } from "@/features/workflows/workflowPageModel";
import { api, type AvailabilityWatch, type LibrarySource } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

const POLL_INTERVAL_MS = 5000;

export type AvailabilityWatchState = ReturnType<typeof useAvailabilityWatch>;

/**
 * The shared watch, its compatible remote sources, and one poll, for every
 * surface of a page that shows the watch. It loads the first time it becomes
 * active, reads the watch again on each later activation, and polls only
 * while active and the page is visible.
 */
export function useAvailabilityWatch(active: boolean) {
  const [watch, setWatch] = useState<AvailabilityWatch | null>(null);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loadKey, setLoadKey] = useState(0);
  const loaded = watch !== null;
  // The first load needs no immediate second read when polling starts.
  const fresh = useRef(false);

  const refresh = useCallback(async () => {
    const next = await api.getAvailabilityWatch();
    setWatch(next);
    setLoadError("");
    return next;
  }, []);

  useEffect(() => {
    if (!active || loaded) return;
    setLoading(true);
    return startLoad((signal) => Promise.all([api.getAvailabilityWatch(), api.listLibrarySources(signal)]), {
      onSuccess: ([next, nextSources]) => {
        fresh.current = true;
        setWatch(next);
        setSources(
          nextSources.filter(
            (source) =>
              source.enabled && ["kikoeru_compatible", "kikoeru_compatible_number178"].includes(source.sourceType),
          ),
        );
        setLoadError("");
      },
      onError: (error) =>
        setLoadError(error instanceof Error ? error.message : workflowCopy("availabilityWatchLoadFailed")),
      onSettled: () => setLoading(false),
    });
  }, [active, loaded, loadKey]);

  // A later activation reads the watch again, since cards elsewhere on the
  // page may have added targets; then the poll keeps it current.
  useEffect(() => {
    if (!active || !loaded) return;
    const poll = () => {
      if (!document.hidden) void refresh().catch(() => undefined);
    };
    if (fresh.current) fresh.current = false;
    else poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [active, loaded, refresh]);

  const sourceName = useCallback(
    (sourceId: number | null) =>
      sourceId ? (sources.find((source) => source.id === sourceId)?.displayName ?? `#${sourceId}`) : "",
    [sources],
  );

  return {
    watch,
    sources,
    loading: loading || (active && !loaded && !loadError),
    loadError,
    setWatch,
    refresh,
    sourceName,
    /** Loads the watch and its sources again after a failed first load. */
    retry: () => {
      setLoadError("");
      setLoadKey((value) => value + 1);
    },
  };
}

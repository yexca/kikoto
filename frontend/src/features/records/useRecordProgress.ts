import { useCallback, useEffect, useRef, useState } from "react";

import { api, type RecordProgress } from "@/lib/api";

import { createProgressLoader, type ProgressLoader } from "./recordProgress";

/**
 * Saved progress for the open folder's videos, read as their tiles scroll
 * near the viewport through a bounded loader. `remember` applies a position the
 * player just saved without reading it back.
 */
export function useRecordProgress(folderKey: number, enabled: boolean) {
  const [progress, setProgress] = useState<ReadonlyMap<number, RecordProgress>>(() => new Map());
  const loader = useRef<ProgressLoader | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const observed = useRef(new Map<Element, number>());

  useEffect(() => {
    setProgress(new Map());
    if (!enabled) return;
    const nextLoader = createProgressLoader({
      load: (id, signal) => api.getRecordProgress(id, signal),
      onLoaded: (id, value) =>
        setProgress((current) => {
          const next = new Map(current);
          next.set(id, value);
          return next;
        }),
    });
    loader.current = nextLoader;
    const elements = observed.current;
    const nextObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const id = elements.get(entry.target);
                if (id !== undefined) nextLoader.request(id);
                nextObserver?.unobserve(entry.target);
                elements.delete(entry.target);
              }
            },
            { rootMargin: "200px 0px" },
          );
    observer.current = nextObserver;
    for (const [element, id] of elements) {
      if (nextObserver) nextObserver.observe(element);
      else nextLoader.request(id);
    }
    return () => {
      nextLoader.cancel();
      nextObserver?.disconnect();
      if (loader.current === nextLoader) loader.current = null;
      if (observer.current === nextObserver) observer.current = null;
    };
  }, [enabled, folderKey]);

  /** A ref callback for a video tile: its progress loads once the tile nears the viewport. */
  const observe = useCallback((id: number, element: Element | null) => {
    if (!element) return;
    observed.current.set(element, id);
    if (observer.current) observer.current.observe(element);
    else loader.current?.request(id);
    return () => {
      observer.current?.unobserve(element);
      observed.current.delete(element);
    };
  }, []);

  /** Reads one video's progress now, as the folder header's Continue action needs. */
  const request = useCallback((id: number) => loader.current?.request(id), []);

  const remember = useCallback((id: number, value: RecordProgress) => {
    setProgress((current) => {
      const next = new Map(current);
      next.set(id, { ...value, lastPlayedAt: value.lastPlayedAt ?? new Date().toISOString() });
      return next;
    });
  }, []);

  return { progress, observe, request, remember };
}

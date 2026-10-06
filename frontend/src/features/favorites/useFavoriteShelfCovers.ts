import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { favoriteShelfCovers } from "./favoriteShelfModel";

// A few spare works cover duplicates and works without art.
const coverSampleSize = 8;

/**
 * The shelf artwork, from the shelf's most recently added works. It ignores
 * the status, search, resource, sort, and page of the works below, so changing
 * a filter never repaints the header. The previous artwork stays while
 * another shelf loads, and a failure keeps the icon tile.
 */
export function useFavoriteShelfCovers({
  enabled,
  listID,
  requestKey,
}: {
  enabled: boolean;
  listID: "all" | number;
  /** Changes whenever the shelf membership may have changed. */
  requestKey: string;
}) {
  const [covers, setCovers] = useState<string[]>([]);
  const loadedKeyRef = useRef("");
  const key = `${listID}:${requestKey}`;

  useEffect(() => {
    if (!enabled || loadedKeyRef.current === key) return;
    const controller = new AbortController();
    api
      .listFavoriteWorksPage(1, coverSampleSize, "", listID, "all", "all", [], "added", "desc", 1, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        loadedKeyRef.current = key;
        setCovers(favoriteShelfCovers(result.works));
      })
      .catch(() => {
        if (!controller.signal.aborted) setCovers([]);
      });
    return () => controller.abort();
  }, [enabled, key, listID]);

  return covers;
}

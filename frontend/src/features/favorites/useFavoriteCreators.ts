import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type CircleSummary, type CurrentUser, type VoiceSummary } from "@/lib/api";
import { loadAllPages } from "@/lib/pagedList";

// The largest page the creator list endpoints serve.
const favoriteCreatorPageSize = 100;

/**
 * The favorite circles and voice actors of the signed-in user, read whole
 * once per user and again on each reload. `notifyUnavailable` reports a
 * failed read and sets the shelf's load error.
 */
export function useFavoriteCreators({
  active,
  user,
  notifyUnavailable,
}: {
  active: boolean;
  user: CurrentUser | null;
  notifyUnavailable: (error: unknown, setLoadError: (message: string) => void) => void;
}) {
  const principalID = user?.id ?? null;
  const [circles, setCircles] = useState<CircleSummary[]>([]);
  const [voices, setVoices] = useState<VoiceSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [snapshotUserID, setSnapshotUserID] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRequestKey = useRef("");

  useEffect(() => {
    if (!user) {
      loadedRequestKey.current = "";
      setCircles([]);
      setVoices([]);
      setSnapshotUserID(null);
      setLoadError("");
      setIsLoading(false);
      return;
    }
    if (!active) return;
    const requestKey = `${principalID ?? "anonymous"}:${reloadToken}`;
    if (loadedRequestKey.current === requestKey) return;
    const controller = new AbortController();
    let cancelled = false;
    setIsLoading(true);
    setLoadError("");
    // Favorites are shown and counted as a whole, so every page is read.
    Promise.all([
      loadAllPages(
        (page) =>
          api
            .listCircles({ filter: "favorite", page, pageSize: favoriteCreatorPageSize, signal: controller.signal })
            .then((result) => ({ items: result.circles, total: result.total })),
        favoriteCreatorPageSize,
      ),
      loadAllPages(
        (page) =>
          api
            .listVoices({ filter: "favorite", page, pageSize: favoriteCreatorPageSize, signal: controller.signal })
            .then((result) => ({ items: result.voices, total: result.total })),
        favoriteCreatorPageSize,
      ),
    ])
      .then(([favoriteCircles, favoriteVoices]) => {
        if (cancelled) return;
        loadedRequestKey.current = requestKey;
        setCircles(favoriteCircles);
        setVoices(favoriteVoices);
        setSnapshotUserID(principalID);
      })
      .catch((error) => {
        if (!cancelled) notifyUnavailable(error, setLoadError);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [active, user, reloadToken, notifyUnavailable, principalID]);

  // Stable so unchanged creator cards skip rendering.
  const changeCircle = useStableCallback((next: CircleSummary) =>
    setCircles((items) => items.map((item) => (item.externalId === next.externalId ? { ...item, ...next } : item))),
  );
  const changeVoice = useStableCallback((next: VoiceSummary) =>
    setVoices((items) => items.map((item) => (item.personId === next.personId ? { ...item, ...next } : item))),
  );

  return {
    favoriteCircles: circles.filter((circle) => circle.favorite),
    favoriteVoices: voices.filter((voice) => voice.favorite),
    isLoading,
    hasSnapshot: snapshotUserID === principalID,
    loadError,
    reload: () => setReloadToken((value) => value + 1),
    changeCircle,
    changeVoice,
  };
}

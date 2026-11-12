import { useCallback, useEffect, useMemo, useState } from "react";

import { api, type RecordAsset, type RecordProgress } from "@/lib/api";

/**
 * Saved progress for the open folder's videos: what the folder listing
 * reported, overlaid with positions the player saved during this visit so a
 * tile and the folder's Continue action update without reading the folder again.
 */
export function useRecordProgress(folderKey: number, videos: readonly RecordAsset[]) {
  const [saved, setSaved] = useState<{ folderKey: number; values: ReadonlyMap<number, RecordProgress> }>(() => ({
    folderKey,
    values: new Map(),
  }));
  const savedHere = saved.folderKey === folderKey ? saved.values : null;

  const progress = useMemo(() => {
    const map = new Map<number, RecordProgress>();
    for (const video of videos) {
      const value = savedHere?.get(video.id) ?? video.progress;
      if (value) map.set(video.id, value);
    }
    return map as ReadonlyMap<number, RecordProgress>;
  }, [savedHere, videos]);

  const remember = useCallback(
    (id: number, value: RecordProgress) =>
      setSaved((current) => {
        const values = new Map(current.folderKey === folderKey ? current.values : []);
        values.set(id, { ...value, lastPlayedAt: value.lastPlayedAt ?? new Date().toISOString() });
        return { folderKey, values };
      }),
    [folderKey],
  );

  return { progress, remember };
}

/**
 * The viewer's unfinished videos for the Continue watching row, read while
 * `active`, again each time it becomes active, and when `savedToken`
 * changes, since the player's last save can land after it closes.
 */
export function useRecordContinue(active: boolean, savedToken: number) {
  const [assets, setAssets] = useState<RecordAsset[]>([]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api
      .listRecordContinue(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setAssets(result.assets);
      })
      .catch(() => {
        // The row is optional; the folder stays usable without it.
      });
    return () => controller.abort();
  }, [active, savedToken]);
  return assets;
}

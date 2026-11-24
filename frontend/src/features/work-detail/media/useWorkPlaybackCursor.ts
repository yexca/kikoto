import { useCallback, useEffect, useRef, useState } from "react";

import { useLatestLoad } from "@/hooks/useLatestLoad";
import { PLAYBACK_CURSOR_UPDATED_EVENT } from "@/lib/appEvents";
import { api, type MediaProgressUpdate, type WorkProgressSummary } from "@/lib/api";
import { cursorUpdateAffectsWork } from "./playbackCursorModel";

export function useWorkPlaybackCursor(workId: number | null) {
  const [cursor, setCursor] = useState<WorkProgressSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const latest = useLatestLoad();
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const reload = useCallback(() => {
    if (!workId) {
      latest.cancel();
      setCursor(null);
      setIsLoading(false);
      return Promise.resolve();
    }
    setIsLoading(true);
    return latest.run(() => api.getWorkPlaybackCursor(workId), {
      onSuccess: (response) => setCursor(response.cursor),
      onSettled: () => setIsLoading(false),
    });
  }, [latest, workId]);

  useEffect(() => {
    setCursor(null);
    void reload();
    return latest.cancel;
  }, [latest, reload]);

  useEffect(() => {
    if (!workId) return;
    const handleCursorUpdate = (event: Event) => {
      const update = (event as CustomEvent<MediaProgressUpdate>).detail;
      if (!update || !cursorUpdateAffectsWork(workId, cursorRef.current, update)) return;
      void reload();
    };
    window.addEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleCursorUpdate);
    return () => window.removeEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleCursorUpdate);
  }, [reload, workId]);

  return { cursor, isLoading, reload };
}

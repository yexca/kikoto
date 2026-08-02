import { useCallback, useEffect, useRef, useState } from "react";

import { PLAYBACK_CURSOR_UPDATED_EVENT } from "@/app/events";
import { api, type MediaProgressUpdate, type WorkProgressSummary } from "@/lib/api";
import { cursorUpdateAffectsWork } from "./playbackCursorModel";

export function useWorkPlaybackCursor(workId: number | null) {
  const [cursor, setCursor] = useState<WorkProgressSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const requestVersionRef = useRef(0);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  const reload = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    if (!workId) {
      setCursor(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const response = await api.getWorkPlaybackCursor(workId);
      if (requestVersion === requestVersionRef.current) setCursor(response.cursor);
    } finally {
      if (requestVersion === requestVersionRef.current) setIsLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    setCursor(null);
    void reload().catch(() => {});
    return () => {
      requestVersionRef.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    if (!workId) return;
    const handleCursorUpdate = (event: Event) => {
      const update = (event as CustomEvent<MediaProgressUpdate>).detail;
      if (!update || !cursorUpdateAffectsWork(workId, cursorRef.current, update)) return;
      void reload().catch(() => {});
    };
    window.addEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleCursorUpdate);
    return () => window.removeEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleCursorUpdate);
  }, [reload, workId]);

  return { cursor, isLoading, reload };
}

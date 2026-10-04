import { useEffect, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { PLAYBACK_CURSOR_UPDATED_EVENT, type PlaybackCursorUpdatedDetail } from "@/lib/appEvents";

/**
 * The newest playback cursor the current account saved while this directory is
 * open. A loaded tree keeps the cursor it was built with, so rows prefer this
 * one when it belongs to the same tree.
 */
export function useLivePlaybackCursor(): PlaybackCursorUpdatedDetail | null {
  const auth = useAuth();
  const principalID = auth.user?.id ?? null;
  const [cursor, setCursor] = useState<PlaybackCursorUpdatedDetail | null>(null);

  useEffect(() => {
    setCursor(null);
    const handleUpdate = (event: Event) => {
      const update = (event as CustomEvent<PlaybackCursorUpdatedDetail>).detail;
      if (!update || update.mediaItemId <= 0 || update.principalID !== principalID) return;
      setCursor(update);
    };
    window.addEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(PLAYBACK_CURSOR_UPDATED_EVENT, handleUpdate);
  }, [principalID]);

  return cursor;
}

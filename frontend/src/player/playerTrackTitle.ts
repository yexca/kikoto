import { useCallback } from "react";

import { useOriginalFileNames } from "@/lib/originalFileNames";

import type { PlayerTrack } from "./playerTypes";

/** The name a queued track shows: its display name, unless it has none or the listener asked for real names. */
export function playerTrackTitle(track: Pick<PlayerTrack, "title" | "displayTitle">, original: boolean) {
  return (!original && track.displayTitle) || track.title;
}

/** Names tracks as the listener's choice between display names and real names says. */
export function usePlayerTrackTitle() {
  const [original] = useOriginalFileNames();
  return useCallback(
    (track: Pick<PlayerTrack, "title" | "displayTitle">) => playerTrackTitle(track, original),
    [original],
  );
}

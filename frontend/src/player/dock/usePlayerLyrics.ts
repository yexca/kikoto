import { useEffect, useMemo, useState } from "react";

import { api, type TimedLyricsResult } from "@/lib/api";
import {
  activeTimedLyricIndex,
  offsetTimedLyrics,
  type ParsedLyrics,
  type TimedLyricLine,
  untimedLyrics,
} from "@/lib/timedLyrics";
import type { LyricsChoice } from "@/player/lyricsMatching";
import { preferredLyricsMediaItemID, usePlayerTime } from "@/player/PlayerProvider";
import type { LyricsPreferenceTarget, PlayerTrack } from "@/player/playerTypes";

/**
 * Resolves and loads the current track's lyrics. The active line follows the
 * playback clock, so read it with `useActiveLyricIndex` in the leaf that shows it.
 * Timed lines already carry the listener's offset.
 */
export function usePlayerLyrics({
  track,
  preferenceOverrides,
  changeLyricsChoice,
  changeLyricsOffset,
}: {
  track: PlayerTrack | null;
  preferenceOverrides: Record<string, number | null>;
  changeLyricsChoice: (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => Promise<void>;
  changeLyricsOffset: (target: LyricsPreferenceTarget, offsetMs: number) => void;
}) {
  const [lyricsFile, setLyricsFile] = useState<TimedLyricsResult | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const [activeLyricsLocationId, setActiveLyricsLocationId] = useState<number | null>(null);
  const [usingAutomaticLyrics, setUsingAutomaticLyrics] = useState(true);
  const lyricsOffsetMs = track?.lyricsOffsetMs ?? 0;
  const fileLyrics = useMemo<ParsedLyrics>(
    () => (lyricsFile?.timed ? { timed: true, lines: lyricsFile.lines } : untimedLyrics),
    [lyricsFile],
  );
  const parsedLyrics = useMemo(() => offsetTimedLyrics(fileLyrics, lyricsOffsetMs), [fileLyrics, lyricsOffsetMs]);
  const activeLyricsChoice = track?.lyricsChoices?.find((choice) => choice.locationId === activeLyricsLocationId);

  useEffect(() => {
    if (!track) {
      setActiveLyricsLocationId(null);
      setUsingAutomaticLyrics(true);
      return;
    }
    const preferred = preferredLyricsMediaItemID(track, preferenceOverrides);
    const preferredChoice = track.lyricsChoices?.find((choice) => choice.mediaItemId === preferred);
    setActiveLyricsLocationId(
      preferredChoice?.locationId ?? track.autoLyricsLocationId ?? track.lyricsLocationId ?? null,
    );
    setUsingAutomaticLyrics(!preferred);
  }, [preferenceOverrides, track]);

  useEffect(() => {
    setLyricsFile(null);
    setLyricsError("");
    if (!activeLyricsLocationId) return;
    const controller = new AbortController();
    // The server reads the file where its bytes are, within its text preview
    // limit, and returns its timed lines.
    const lyricsURL = activeLyricsChoice?.url;
    const request = lyricsURL
      ? api.getTextUrlLyrics(lyricsURL, controller.signal)
      : api.getMediaLyrics(activeLyricsLocationId, controller.signal);
    request
      .then((result) => {
        if (!controller.signal.aborted) setLyricsFile(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLyricsError(error instanceof Error ? error.message : "Lyrics preview failed.");
      });
    return () => controller.abort();
  }, [activeLyricsChoice?.url, activeLyricsLocationId]);

  const selectLyricsLocation = (locationId: number | null) => {
    if (!track) return;
    if (locationId === null) {
      void changeLyricsChoice(track, null);
      return;
    }
    const choice = track.lyricsChoices?.find((item) => item.locationId === locationId);
    if (choice) void changeLyricsChoice(track, choice);
  };

  const setLyricsOffset = (offsetMs: number) => {
    if (track) changeLyricsOffset(track, offsetMs);
  };

  return {
    /** The file's own text when it holds no timed line; null until the file has loaded. */
    lyricsText: lyricsFile === null ? null : (lyricsFile.text ?? ""),
    /** The file's lines before the listener's offset; a new file is a new object. */
    fileLyrics,
    lyricsError,
    activeLyricsLocationId,
    activeLyricsChoice,
    usingAutomaticLyrics,
    parsedLyrics,
    selectLyricsLocation,
    lyricsOffsetMs,
    setLyricsOffset,
  };
}

/** The lyric line at the current playback position; re-renders with the clock. */
export function useActiveLyricIndex(lines: TimedLyricLine[]) {
  const { currentTime } = usePlayerTime();
  return useMemo(() => activeTimedLyricIndex(lines, currentTime), [lines, currentTime]);
}

export type PlayerLyricsState = ReturnType<typeof usePlayerLyrics>;

import { useEffect, useMemo, useState } from "react";

import { api, assetURL } from "@/lib/api";
import type { LyricsChoice } from "@/player/lyricsMatching";
import { preferredLyricsMediaItemID, usePlayerTime } from "@/player/PlayerProvider";
import type { LyricsPreferenceTarget, PlayerTrack } from "@/player/playerTypes";

import { activeTimedLyricIndex, parseTimedLyrics, type TimedLyricLine } from "./timedLyrics";

const MAX_LYRICS_BYTES = 512 * 1024;

/**
 * Resolves and loads the current track's lyrics. The active line follows the
 * playback clock, so read it with `useActiveLyricIndex` in the leaf that shows it.
 */
export function usePlayerLyrics({
  track,
  preferenceOverrides,
  changeLyricsChoice,
}: {
  track: PlayerTrack | null;
  preferenceOverrides: Record<string, number | null>;
  changeLyricsChoice: (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => Promise<void>;
}) {
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const [activeLyricsLocationId, setActiveLyricsLocationId] = useState<number | null>(null);
  const [usingAutomaticLyrics, setUsingAutomaticLyrics] = useState(true);
  const parsedLyrics = useMemo(() => parseTimedLyrics(lyricsText ?? ""), [lyricsText]);
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
    setLyricsText(null);
    setLyricsError("");
    if (!activeLyricsLocationId) return;
    let cancelled = false;
    const lyricsURL = activeLyricsChoice?.url;
    const request = lyricsURL
      ? fetch(assetURL(lyricsURL), { headers: { Accept: "text/plain,text/*" } }).then(async (response) => {
          if (!response.ok) throw new Error(`Lyrics preview returned HTTP ${response.status}.`);
          const length = Number(response.headers.get("content-length") ?? 0);
          if (length > MAX_LYRICS_BYTES) throw new Error("Lyrics file is too large to preview.");
          const content = await response.text();
          if (content.length > MAX_LYRICS_BYTES) throw new Error("Lyrics file is too large to preview.");
          return { content };
        })
      : api.getMediaText(activeLyricsLocationId);
    request
      .then((result) => {
        if (!cancelled) setLyricsText(result.content);
      })
      .catch((error) => {
        if (!cancelled) setLyricsError(error instanceof Error ? error.message : "Lyrics preview failed.");
      });
    return () => {
      cancelled = true;
    };
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

  return {
    lyricsText,
    lyricsError,
    activeLyricsLocationId,
    activeLyricsChoice,
    usingAutomaticLyrics,
    parsedLyrics,
    selectLyricsLocation,
  };
}

/** The lyric line at the current playback position; re-renders with the clock. */
export function useActiveLyricIndex(lines: TimedLyricLine[]) {
  const { currentTime } = usePlayerTime();
  return useMemo(() => activeTimedLyricIndex(lines, currentTime), [lines, currentTime]);
}

export type PlayerLyricsState = ReturnType<typeof usePlayerLyrics>;

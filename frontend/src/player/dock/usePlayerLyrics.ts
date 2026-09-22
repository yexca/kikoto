import { useEffect, useMemo, useState } from "react";

import { api, assetURL } from "@/lib/api";
import type { LyricsChoice } from "@/player/lyricsMatching";
import { preferredLyricsMediaItemID } from "@/player/PlayerProvider";
import type { LyricsPreferenceTarget, PlayerTrack } from "@/player/playerTypes";

import { activeTimedLyricIndex, parseTimedLyrics } from "./timedLyrics";

const MAX_LYRICS_BYTES = 512 * 1024;

/** Resolves, loads, and tracks the active line of the current track's lyrics. */
export function usePlayerLyrics({
  track,
  currentTime,
  preferenceOverrides,
  changeLyricsChoice,
}: {
  track: PlayerTrack | null;
  currentTime: number;
  preferenceOverrides: Record<string, number | null>;
  changeLyricsChoice: (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => Promise<void>;
}) {
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const [activeLyricsLocationId, setActiveLyricsLocationId] = useState<number | null>(null);
  const [usingAutomaticLyrics, setUsingAutomaticLyrics] = useState(true);
  const parsedLyrics = useMemo(() => parseTimedLyrics(lyricsText ?? ""), [lyricsText]);
  const activeLyricIndex = useMemo(
    () => activeTimedLyricIndex(parsedLyrics.lines, currentTime),
    [parsedLyrics.lines, currentTime],
  );
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

  const currentLyricLine =
    parsedLyrics.timed && activeLyricIndex >= 0 ? (parsedLyrics.lines[activeLyricIndex]?.text ?? "") : "";

  return {
    lyricsText,
    lyricsError,
    activeLyricsLocationId,
    activeLyricsChoice,
    usingAutomaticLyrics,
    parsedLyrics,
    activeLyricIndex,
    currentLyricLine,
    selectLyricsLocation,
  };
}

export type PlayerLyricsState = ReturnType<typeof usePlayerLyrics>;

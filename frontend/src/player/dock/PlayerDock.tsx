import { useCallback, useEffect, useRef, useState } from "react";

import { usePlayer, usePlayerTime } from "@/player/PlayerProvider";
import { persistDockMode, restoreDockMode } from "@/player/playerPersistence";
import type { DockMode, PlayerTrack } from "@/player/playerTypes";
import { useScreenLyrics, useScreenLyricsSync, type ScreenLyricsController } from "@/player/screenLyrics";

import { CompactPlayer } from "./CompactPlayer";
import { FullPlayer } from "./FullPlayer";
import { MiniPlayer } from "./MiniPlayer";
import type { TimedLyricLine } from "./timedLyrics";
import { useActiveLyricIndex, usePlayerLyrics } from "./usePlayerLyrics";

const MOBILE_PLAYER_QUERY = "(max-width: 1023px)";

/**
 * Global player surface: a Mini bubble, a Compact bar, or the full Now Playing view.
 * The dock does not read the playback clock; the leaves that show it do.
 */
export function PlayerDock() {
  const player = usePlayer();
  const isMobile = useIsMobilePlayer();
  const [dockMode, setDockModeState] = useState<DockMode>(() => restoreDockMode(isMobile));
  const dockLayoutRef = useRef(isMobile);
  const track = player.currentTrack;
  const lyrics = usePlayerLyrics({
    track,
    preferenceOverrides: player.lyricsPreferenceOverrides,
    changeLyricsChoice: player.changeLyricsChoice,
  });
  const screenLyrics = useScreenLyrics();
  const screenLyricsSync = (
    <ScreenLyricsSync
      screenLyrics={screenLyrics}
      track={track}
      activeLyricsLocationId={lyrics.activeLyricsLocationId}
      lines={lyrics.parsedLyrics.lines}
      playing={player.isPlaying}
      playbackRate={player.playbackRate}
      onTogglePlay={player.togglePlay}
      onPrevious={player.previous}
      onNext={player.next}
    />
  );

  const setDockMode = useCallback(
    (mode: DockMode, options?: { persist?: boolean }) => {
      setDockModeState(mode);
      if (options?.persist !== false) persistDockMode(isMobile, mode);
    },
    [isMobile],
  );

  useEffect(() => {
    if (dockLayoutRef.current === isMobile) return;
    dockLayoutRef.current = isMobile;
    setDockModeState(restoreDockMode(isMobile));
  }, [isMobile]);

  useEffect(() => {
    document.documentElement.dataset.playerActive = track ? "true" : "false";
    document.documentElement.dataset.playerMode = track ? dockMode : "none";
    return () => {
      delete document.documentElement.dataset.playerActive;
      delete document.documentElement.dataset.playerMode;
    };
  }, [track, dockMode]);

  return (
    <>
      {screenLyricsSync}
      {!track ? null : dockMode === "mini" ? (
        <MiniPlayer player={player} track={track} isMobile={isMobile} onDockModeChange={setDockMode} />
      ) : dockMode === "compact" ? (
        <CompactPlayer player={player} track={track} onDockModeChange={setDockMode} />
      ) : (
        <FullPlayer
          player={player}
          track={track}
          isMobile={isMobile}
          lyrics={lyrics}
          screenLyrics={screenLyrics}
          onDockModeChange={setDockMode}
        />
      )}
    </>
  );
}

/** Keeps an open screen-lyrics surface on the current line; re-renders with the playback clock. */
function ScreenLyricsSync({
  screenLyrics,
  track,
  activeLyricsLocationId,
  lines,
  playing,
  playbackRate,
  onTogglePlay,
  onPrevious,
  onNext,
}: {
  screenLyrics: ScreenLyricsController;
  track: PlayerTrack | null;
  activeLyricsLocationId: number | null;
  lines: TimedLyricLine[];
  playing: boolean;
  playbackRate: number;
  onTogglePlay: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { currentTime } = usePlayerTime();
  const activeIndex = useActiveLyricIndex(lines);
  const portal = useScreenLyricsSync(
    screenLyrics,
    {
      trackKey: `${track?.queueItemId ?? track?.locationId ?? ""}:${activeLyricsLocationId ?? ""}`,
      title: track?.title ?? "",
      subtitle: track?.circle || track?.workTitle || "",
      lines,
      activeIndex,
      currentTime,
      playing,
      playbackRate,
    },
    { onTogglePlay, onPrevious, onNext },
  );
  return track ? portal : null;
}

function useIsMobilePlayer() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_PLAYER_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_PLAYER_QUERY);
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}

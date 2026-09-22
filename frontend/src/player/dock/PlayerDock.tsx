import { useCallback, useEffect, useRef, useState } from "react";

import { usePlayer } from "@/player/PlayerProvider";
import { persistDockMode, restoreDockMode } from "@/player/playerPersistence";
import type { DockMode } from "@/player/playerTypes";
import { useScreenLyrics } from "@/player/screenLyrics";

import { CompactPlayer } from "./CompactPlayer";
import { FullPlayer } from "./FullPlayer";
import { MiniPlayer } from "./MiniPlayer";
import { usePlayerLyrics } from "./usePlayerLyrics";

const MOBILE_PLAYER_QUERY = "(max-width: 1023px)";

/** Global player surface: a Mini bubble, a Compact bar, or the full Now Playing view. */
export function PlayerDock() {
  const player = usePlayer();
  const isMobile = useIsMobilePlayer();
  const [dockMode, setDockModeState] = useState<DockMode>(() => restoreDockMode(isMobile));
  const dockLayoutRef = useRef(isMobile);
  const track = player.currentTrack;
  const lyrics = usePlayerLyrics({
    track,
    currentTime: player.currentTime,
    preferenceOverrides: player.lyricsPreferenceOverrides,
    changeLyricsChoice: player.changeLyricsChoice,
  });
  const screenLyrics = useScreenLyrics(
    {
      trackKey: `${track?.queueItemId ?? track?.locationId ?? ""}:${lyrics.activeLyricsLocationId ?? ""}`,
      title: track?.title ?? "",
      subtitle: track?.circle || track?.workTitle || "",
      lines: lyrics.parsedLyrics.lines,
      activeIndex: lyrics.activeLyricIndex,
      currentTime: player.currentTime,
      playing: player.isPlaying,
      playbackRate: player.playbackRate,
    },
    { onTogglePlay: player.togglePlay, onPrevious: player.previous, onNext: player.next },
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

  if (!track) return null;

  const progress = player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0;

  return (
    <>
      {screenLyrics.portal}
      {dockMode === "mini" ? (
        <MiniPlayer
          player={player}
          track={track}
          isMobile={isMobile}
          progress={progress}
          onDockModeChange={setDockMode}
        />
      ) : dockMode === "compact" ? (
        <CompactPlayer player={player} track={track} progress={progress} onDockModeChange={setDockMode} />
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

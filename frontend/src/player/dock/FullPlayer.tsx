import {
  HardDrive,
  ListMusic,
  ListOrdered,
  MessageSquareQuote,
  MoreHorizontal,
  PictureInPicture2,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  Timer,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { ANDROID_BACK_EVENT } from "@/app/events";
import { useToast } from "@/components/ui/toast";
import { assetURL } from "@/lib/api";
import { historyStateWithReturn, NAVIGATION_EVENT } from "@/lib/browserHistory";
import { cn } from "@/lib/tailwindClassNames";
import type { usePlayer } from "@/player/PlayerProvider";
import type { useScreenLyrics } from "@/player/screenLyrics";
import type { DockMode, PlayerTrack } from "@/player/playerTypes";
import { orderedTrackLocations } from "@/player/trackLocations";

import { formatRemaining, formatSleepRemaining, formatTime } from "./playerFormat";
import { CoverImage, GlyphButton, PlayPauseGlyph, SeekBar, SeekIcon } from "./playerControls";
import { LyricsLoadingSkeleton, LyricsPanel } from "./PlayerLyricsPanel";
import { locationLabel, MoreOptionsMenu, SleepTimerMenu, SourceMenu } from "./PlayerMenus";
import { PlayerQueuePanel } from "./PlayerQueuePanel";
import type { PlayerLyricsState } from "./usePlayerLyrics";

type PlayerSidePanel = "lyrics" | "queue";
type FullDrag = { pointerId: number; startY: number; startedAt: number; moved: boolean };

export function FullPlayer({
  player,
  track,
  isMobile,
  lyrics,
  screenLyrics,
  onDockModeChange,
}: {
  player: ReturnType<typeof usePlayer>;
  track: PlayerTrack;
  isMobile: boolean;
  lyrics: PlayerLyricsState;
  screenLyrics: ReturnType<typeof useScreenLyrics>;
  onDockModeChange: (mode: DockMode, options?: { persist?: boolean }) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [sidePanel, setSidePanel] = useState<PlayerSidePanel | null>(null);
  const [isSleepOpen, setIsSleepOpen] = useState(false);
  const [isCustomSleepOpen, setIsCustomSleepOpen] = useState(false);
  const [isSourceOpen, setIsSourceOpen] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const sleepButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const sourceButtonRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<FullDrag | null>(null);
  const suppressCollapseClickRef = useRef(false);
  const coverTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const sidePanelOpen = sidePanel !== null;
  const { parsedLyrics, activeLyricIndex, activeLyricsLocationId } = lyrics;
  const busy = player.isPlaying && player.isBuffering;
  const subtitle = track.circle || track.workTitle;
  const availableLocations = orderedTrackLocations(track);
  const currentLocation =
    availableLocations.find((location) => location.locationId === track.locationId) ?? availableLocations[0];
  const modeLabel = t(`player.modes.${player.mode}`, { defaultValue: player.mode });
  const atQueueStart = player.currentIndex <= 0 && player.mode !== "loop";
  const atQueueEnd = player.currentIndex >= player.queue.length - 1 && player.mode !== "loop";

  useEffect(() => {
    setIsMoreOpen(false);
  }, [track.queueItemId]);

  useEffect(() => {
    if (!isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    const handleBack = (event: Event) => {
      const close = (action: () => void) => {
        action();
        event.preventDefault();
      };
      if (isSleepOpen) return close(() => setIsSleepOpen(false));
      if (isCustomSleepOpen) return close(() => setIsCustomSleepOpen(false));
      if (isSourceOpen) return close(() => setIsSourceOpen(false));
      if (isMoreOpen) return close(() => setIsMoreOpen(false));
      if (sidePanel) return close(() => setSidePanel(null));
      close(() => onDockModeChange("compact"));
    };
    window.addEventListener(ANDROID_BACK_EVENT, handleBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, handleBack);
  }, [isCustomSleepOpen, isMobile, isMoreOpen, isSleepOpen, isSourceOpen, onDockModeChange, sidePanel]);

  const toggleSidePanel = (value: PlayerSidePanel) => {
    if (value === "lyrics" && !activeLyricsLocationId) return;
    setSidePanel((current) => (current === value ? null : value));
  };

  const toggleScreenLyrics = async () => {
    if (screenLyrics.open) {
      screenLyrics.stop();
      return;
    }
    const result = await screenLyrics.start();
    if (result === "permission-required") toast.info(t("player.screenLyricsPermission"));
    else if (result === "unsupported") toast.info(t("player.screenLyricsUnsupported"));
    else if (result === "failed") toast.error(t("player.screenLyricsFailed"));
  };

  const openWorkDetail = () => {
    if (!track.workCode) return;
    if (isMobile) onDockModeChange("compact", { persist: false });
    const returnTo = window.location.pathname + window.location.search;
    window.history.pushState(historyStateWithReturn(returnTo, "Back"), "", `/${encodeURIComponent(track.workCode)}`);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const handleCoverClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!isMobile) return;
    const now = performance.now();
    if (event.detail >= 2) {
      coverTapRef.current = null;
      openWorkDetail();
      return;
    }
    const previous = coverTapRef.current;
    coverTapRef.current = { at: now, x: event.clientX, y: event.clientY };
    if (!previous) return;
    const closeInTime = now - previous.at <= 360;
    const closeInSpace = Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 28;
    if (closeInTime && closeInSpace) {
      coverTapRef.current = null;
      openWorkDetail();
    }
  };

  const moreButton = (
    <GlyphButton
      ref={moreButtonRef}
      data-player-no-drag
      className="h-9 w-9 bg-foreground/[0.07] text-foreground/80"
      selected={player.playbackRate !== 1 || player.compatibilityPlaybackEnabled}
      onClick={() => setIsMoreOpen((value) => !value)}
      aria-label={t("player.moreOptions")}
      aria-expanded={isMoreOpen}
      aria-haspopup="dialog"
      title={t("player.moreOptions")}
    >
      <MoreHorizontal className="h-5 w-5" />
    </GlyphButton>
  );

  const lyricsContent = activeLyricsLocationId ? (
    lyrics.lyricsError ? (
      <div className="p-5 text-sm text-muted-foreground">{lyrics.lyricsError}</div>
    ) : lyrics.lyricsText === null ? (
      <LyricsLoadingSkeleton />
    ) : (
      <LyricsPanel
        title={lyrics.activeLyricsChoice?.title ?? track.lyricsTitle}
        text={lyrics.lyricsText}
        parsed={parsedLyrics}
        activeIndex={activeLyricIndex}
        choices={track.lyricsChoices ?? []}
        activeLocationId={activeLyricsLocationId}
        automatic={lyrics.usingAutomaticLyrics}
        onChoiceChange={lyrics.selectLyricsLocation}
        onSeek={player.seekTo}
      />
    )
  ) : (
    <div className="p-5 text-sm text-muted-foreground">{t("player.noLyrics")}</div>
  );

  return (
    <section
      data-player-surface="full"
      aria-label={t("player.nowPlaying")}
      className="fixed inset-0 z-50 h-[100dvh] animate-player-enter overflow-hidden bg-background text-foreground transition-[transform,opacity] duration-200 ease-out lg:inset-auto lg:bottom-6 lg:right-6 lg:h-[min(640px,calc(100dvh-3rem))] lg:w-[400px] lg:rounded-[var(--player-radius-panel)] lg:bg-card/85 lg:shadow-2xl lg:ring-1 lg:ring-foreground/[0.08] lg:backdrop-blur-2xl dark:lg:bg-card/80"
      style={
        isMobile && dragOffset > 0
          ? { transform: `translateY(${dragOffset}px)`, opacity: Math.max(0.55, 1 - dragOffset / 500) }
          : undefined
      }
    >
      {track.coverUrl && (
        <div className="player-ambient pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <img
            src={assetURL(track.coverUrl)}
            alt=""
            decoding="async"
            className="absolute left-1/2 top-[-12%] h-[72%] w-[150%] max-w-none -translate-x-1/2 object-cover opacity-45 blur-3xl saturate-150 dark:opacity-35"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-background/10 via-background/65 to-background lg:from-card/10 lg:via-card/70 lg:to-card/95" />
        </div>
      )}
      <div
        className="relative z-10 flex h-full flex-col pl-[var(--safe-area-left)] pr-[var(--safe-area-right)] pt-[var(--safe-area-top)] lg:px-0 lg:pt-0"
        style={{ touchAction: sidePanelOpen ? undefined : "pan-x" }}
        onPointerDown={(event) => {
          if (!isMobile) return;
          const target = event.target as HTMLElement;
          const isHandle = Boolean(target.closest("[data-player-handle]"));
          const isPanelDragZone = Boolean(target.closest("[data-player-drag-zone]"));
          if (sidePanelOpen && !isHandle && !isPanelDragZone) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (!isHandle && event.clientY > rect.top + rect.height * 0.6) return;
          if (target.closest("input, [data-player-no-drag]")) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startedAt: performance.now(),
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!isMobile || !drag || drag.pointerId !== event.pointerId) return;
          const offset = Math.max(0, event.clientY - drag.startY);
          if (offset > 6) drag.moved = true;
          setDragOffset(offset);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const offset = Math.max(0, event.clientY - drag.startY);
          const velocity = offset / Math.max(1, performance.now() - drag.startedAt);
          suppressCollapseClickRef.current = drag.moved;
          if (offset >= 96 || velocity >= 0.55) onDockModeChange("compact");
          setDragOffset(0);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragOffset(0);
        }}
      >
        <div className="relative flex h-9 shrink-0 items-center justify-center lg:h-8">
          <button
            type="button"
            data-player-handle
            className="absolute inset-0 flex touch-none items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              if (suppressCollapseClickRef.current) {
                suppressCollapseClickRef.current = false;
                return;
              }
              onDockModeChange("compact");
            }}
            aria-label={t("player.collapse")}
            title={t("player.collapse")}
          >
            <span className="h-[5px] w-9 rounded-full bg-foreground/20 transition-colors hover:bg-foreground/35" />
          </button>
          <span className="pointer-events-none absolute left-6 text-[11px] font-medium tabular-nums text-muted-foreground lg:left-7">
            {player.currentIndex + 1} / {player.queue.length}
          </span>
        </div>

        <div className="player-primary flex min-h-0 flex-1 flex-col">
          <div className="player-main flex min-h-0 flex-1 flex-col px-6 lg:px-7">
            {sidePanelOpen ? (
              <div className="animate-player-panel-enter flex h-full min-h-0 flex-col gap-3 pb-2">
                <div data-player-drag-zone className="flex min-h-[60px] shrink-0 touch-none items-center gap-3">
                  <CoverImage track={track} className="h-12 w-16 rounded-lg shadow-md" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-semibold" title={track.title}>
                      {track.title}
                    </div>
                    <div className="truncate text-sm text-muted-foreground" title={subtitle}>
                      {subtitle}
                    </div>
                  </div>
                  {moreButton}
                </div>
                <div className="-mx-2 min-h-0 flex-1 overflow-hidden rounded-3xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]">
                  {sidePanel === "lyrics" ? (
                    lyricsContent
                  ) : (
                    <PlayerQueuePanel
                      queue={player.queue}
                      currentIndex={player.currentIndex}
                      isPlaying={player.isPlaying}
                      onSelect={player.selectTrack}
                      onMove={player.moveQueueItem}
                      onMoveTo={player.moveQueueItemTo}
                      onRemove={player.removeQueueItem}
                      onClear={player.clearQueue}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="player-art-stage grid min-h-0 w-full flex-1 place-items-center py-2">
                <button
                  type="button"
                  data-player-cover-shell
                  className="player-art touch-manipulation rounded-[var(--player-radius-cover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={handleCoverClick}
                  onDoubleClick={isMobile ? undefined : openWorkDetail}
                  title={t("player.openWorkTitle")}
                  aria-label={t("player.openWork")}
                >
                  <CoverImage
                    track={track}
                    className={cn(
                      "h-full w-full rounded-[var(--player-radius-cover)] shadow-[0_22px_44px_-18px_rgb(0_0_0/0.55)] transition-[scale] duration-500 [transition-timing-function:cubic-bezier(0.2,0.9,0.3,1.15)] motion-reduce:transition-none",
                      player.isPlaying ? "[scale:1]" : "[scale:0.86] motion-reduce:[scale:1]",
                    )}
                  />
                </button>
              </div>
            )}
          </div>

          <div
            data-player-no-drag
            className="player-controls shrink-0 px-6 pb-[calc(1rem+var(--safe-area-bottom))] pt-1 lg:px-7 lg:pb-5"
          >
            {!sidePanelOpen && (
              <>
                <div data-player-title-block className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xl font-semibold leading-tight tracking-tight" title={track.title}>
                      {track.title}
                    </div>
                    <div className="truncate text-base leading-snug text-muted-foreground" title={subtitle}>
                      {subtitle}
                    </div>
                  </div>
                  {moreButton}
                </div>
                {parsedLyrics.timed && parsedLyrics.lines.length > 0 && (
                  <button
                    type="button"
                    className="mt-1.5 flex min-h-9 w-full items-center rounded-lg text-left text-[15px] font-semibold leading-snug text-foreground/60 transition-colors hover:text-foreground/85"
                    onClick={() => setSidePanel("lyrics")}
                    aria-label={t("player.openLyrics")}
                  >
                    <span key={activeLyricIndex} className="animate-lyric-line line-clamp-2">
                      {lyrics.currentLyricLine || " "}
                    </span>
                  </button>
                )}
              </>
            )}

            <div className="mt-3">
              <SeekBar currentTime={player.currentTime} duration={player.duration} onSeek={player.seekTo} />
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium tabular-nums text-muted-foreground">
                <span className="min-w-12">{formatTime(player.currentTime)}</span>
                <button
                  ref={sourceButtonRef}
                  type="button"
                  className="touch-target relative inline-flex min-w-0 max-w-[55%] items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 font-semibold text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                  onClick={() => setIsSourceOpen((value) => !value)}
                  aria-label={t("player.chooseSource")}
                  aria-haspopup="dialog"
                  aria-expanded={isSourceOpen}
                >
                  <HardDrive className="h-3 w-3 shrink-0" />
                  <span className="truncate">{locationLabel(currentLocation, t)}</span>
                </button>
                <span className="min-w-12 text-right">{formatRemaining(player.currentTime, player.duration)}</span>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between lg:mt-2">
              <GlyphButton
                className="h-12 w-12"
                onClick={player.previous}
                disabled={atQueueStart}
                aria-label={t("player.previous")}
              >
                <SkipBack className="h-7 w-7" fill="currentColor" />
              </GlyphButton>
              <GlyphButton
                className="h-12 w-12"
                onClick={player.seekBackward}
                aria-label={t("player.backward", { seconds: player.seekBackwardSeconds })}
              >
                <SeekIcon direction="back" seconds={player.seekBackwardSeconds} />
              </GlyphButton>
              <GlyphButton
                className="h-[4.5rem] w-[4.5rem]"
                onClick={player.togglePlay}
                aria-label={player.isPlaying ? t("player.pause") : t("player.play")}
                aria-busy={busy}
                title={busy ? t("common.loading") : undefined}
              >
                <PlayPauseGlyph playing={player.isPlaying} buffering={player.isBuffering} className="h-10 w-10" />
              </GlyphButton>
              <GlyphButton
                className="h-12 w-12"
                onClick={player.seekForward}
                aria-label={t("player.forward", { seconds: player.seekForwardSeconds })}
              >
                <SeekIcon direction="forward" seconds={player.seekForwardSeconds} />
              </GlyphButton>
              <GlyphButton
                className="h-12 w-12"
                onClick={player.next}
                disabled={atQueueEnd}
                aria-label={t("player.next")}
              >
                <SkipForward className="h-7 w-7" fill="currentColor" />
              </GlyphButton>
            </div>

            <div className="mt-3 flex items-center justify-between text-foreground/70 lg:mt-2">
              <GlyphButton
                className="h-11 w-11 text-inherit"
                selected={sidePanel === "lyrics"}
                onClick={() => toggleSidePanel("lyrics")}
                disabled={!activeLyricsLocationId}
                aria-pressed={sidePanel === "lyrics"}
                aria-label={sidePanel === "lyrics" ? t("player.hideLyrics") : t("player.viewLyrics")}
                title={
                  !activeLyricsLocationId
                    ? t("player.noMatchedLyrics")
                    : sidePanel === "lyrics"
                      ? t("player.hideLyrics")
                      : t("player.viewLyrics")
                }
              >
                <MessageSquareQuote className="h-5 w-5" />
              </GlyphButton>
              <GlyphButton
                className="h-11 w-11 text-inherit"
                selected={screenLyrics.open}
                onClick={() => void toggleScreenLyrics()}
                disabled={!screenLyrics.open && (!screenLyrics.supported || !parsedLyrics.timed)}
                aria-pressed={screenLyrics.open}
                aria-label={screenLyrics.open ? t("player.closeScreenLyrics") : t("player.screenLyrics")}
                title={
                  !screenLyrics.supported
                    ? t("player.screenLyricsUnsupported")
                    : !parsedLyrics.timed && !screenLyrics.open
                      ? t("player.noMatchedLyrics")
                      : screenLyrics.open
                        ? t("player.closeScreenLyrics")
                        : t("player.screenLyrics")
                }
              >
                <PictureInPicture2 className="h-5 w-5" />
              </GlyphButton>
              <GlyphButton
                className="h-11 w-11 text-inherit"
                selected={player.mode !== "order"}
                onClick={player.cycleMode}
                aria-label={t("player.changeMode", { mode: modeLabel })}
                title={modeLabel}
              >
                {player.mode === "order" ? (
                  <ListOrdered className="h-5 w-5" />
                ) : player.mode === "loop" ? (
                  <Repeat className="h-5 w-5" />
                ) : (
                  <Repeat1 className="h-5 w-5" />
                )}
              </GlyphButton>
              <GlyphButton
                ref={sleepButtonRef}
                className="h-11 min-w-11 gap-1 px-2.5 text-inherit"
                selected={Boolean(player.sleepTimer)}
                onClick={() => setIsSleepOpen((value) => !value)}
                aria-label={t("player.sleepTimer")}
                aria-expanded={isSleepOpen}
                title={t("player.sleepTimer")}
              >
                <Timer className="h-5 w-5" />
                {player.sleepTimer && (
                  <span className="text-[11px] font-semibold tabular-nums">
                    {player.sleepTimer.waitingForTrackEnd
                      ? t("player.track")
                      : formatSleepRemaining(player.sleepRemainingSeconds)}
                  </span>
                )}
              </GlyphButton>
              <GlyphButton
                className="h-11 w-11 text-inherit"
                selected={sidePanel === "queue"}
                onClick={() => toggleSidePanel("queue")}
                aria-pressed={sidePanel === "queue"}
                aria-label={t("player.queue")}
                title={t("player.queue")}
              >
                <ListMusic className="h-5 w-5" />
              </GlyphButton>
            </div>
          </div>
        </div>
      </div>

      <SleepTimerMenu
        open={isSleepOpen}
        anchorRef={sleepButtonRef}
        onOpenChange={setIsSleepOpen}
        player={player}
        customOpen={isCustomSleepOpen}
        onCustomOpenChange={setIsCustomSleepOpen}
      />
      <MoreOptionsMenu
        open={isMoreOpen}
        anchorRef={moreButtonRef}
        onOpenChange={setIsMoreOpen}
        player={player}
        track={track}
      />
      <SourceMenu
        open={isSourceOpen}
        anchorRef={sourceButtonRef}
        onOpenChange={setIsSourceOpen}
        locations={availableLocations}
        currentLocationId={track.locationId}
        onSelect={player.selectLocation}
      />
    </section>
  );
}

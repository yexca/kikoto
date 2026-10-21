import { Minimize2, SkipForward } from "lucide-react";
import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { OverflowMarqueeGroup } from "@/components/ui/overflow-marquee";
import { cn } from "@/lib/tailwindClassNames";
import { usePlayerTime, type usePlayer } from "@/player/PlayerProvider";
import type { DockMode, PlayerTrack } from "@/player/playerTypes";
import { usePlayerTrackTitle } from "@/player/playerTrackTitle";

import { formatScrubTime, formatSignedSeconds, playbackProgressPercent } from "./playerFormat";
import { CoverImage, GlyphButton, PlayPauseGlyph } from "./playerControls";

/** A pointer gesture on the bar; its axis locks once it leaves the dead zone. */
type CompactGestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  originTime: number;
  previewTime: number;
  offsetY: number;
  width: number;
  axis: "seek" | "swipe" | null;
};

const GESTURE_DEAD_ZONE = 7;
// The bar sits near the bottom edge, so a swipe down has less room than a swipe up.
const SWIPE_UP_DISTANCE = 48;
const SWIPE_DOWN_DISTANCE = 32;
const SWIPE_FLICK_DISTANCE = 16;
const SWIPE_FLICK_VELOCITY = 0.5;

export function CompactPlayer({
  player,
  track,
  isMobile,
  onDockModeChange,
}: {
  player: ReturnType<typeof usePlayer>;
  track: PlayerTrack;
  isMobile: boolean;
  onDockModeChange: (mode: DockMode) => void;
}) {
  const { t } = useTranslation();
  const trackTitle = usePlayerTrackTitle();
  const [gesture, setGesture] = useState<CompactGestureState | null>(null);
  const gestureRef = useRef<CompactGestureState | null>(null);
  const suppressClickRef = useRef(false);
  // Mirrors the playback clock for the scrub origin without re-rendering the bar on every update.
  const currentTimeRef = useRef(0);
  const busy = player.isPlaying && player.isBuffering;

  useEffect(() => {
    gestureRef.current = null;
    setGesture(null);
    suppressClickRef.current = false;
  }, [track.locationId]);

  useEffect(() => {
    if (!gesture?.axis) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      gestureRef.current = null;
      setGesture(null);
      suppressNextClick(suppressClickRef);
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [gesture?.axis]);

  const beginGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (player.duration <= 0 && !isMobile)) return;
    if ((event.target as HTMLElement).closest("[data-compact-control]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const state: CompactGestureState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      originTime: currentTimeRef.current,
      previewTime: currentTimeRef.current,
      offsetY: 0,
      width: Math.max(1, rect.width),
      axis: null,
    };
    gestureRef.current = state;
    setGesture(state);
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gestureRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    let axis = state.axis;
    if (!axis) {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < GESTURE_DEAD_ZONE) return;
      // Phones swipe vertically between dock modes; horizontal movement always seeks.
      axis = isMobile && Math.abs(deltaY) > Math.abs(deltaX) ? "swipe" : player.duration > 0 ? "seek" : null;
      if (!axis) {
        gestureRef.current = null;
        setGesture(null);
        return;
      }
    }
    event.preventDefault();
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    let next: CompactGestureState;
    if (axis === "seek") {
      // A full-width drag covers 20% of the track, bounded between 20 seconds and 10 minutes.
      const maximumDelta = Math.min(600, Math.max(20, player.duration * 0.2));
      const previewTime = Math.max(
        0,
        Math.min(player.duration, state.originTime + (deltaX / state.width) * maximumDelta),
      );
      next = { ...state, axis, previewTime };
    } else {
      next = { ...state, axis, offsetY: deltaY };
    }
    gestureRef.current = next;
    suppressClickRef.current = true;
    setGesture(next);
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const state = gestureRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    setGesture(null);
    if (!state.axis) return;
    suppressNextClick(suppressClickRef);
    if (!commit) return;
    if (state.axis === "seek") {
      player.seekTo(state.previewTime);
      return;
    }
    const distance = Math.abs(state.offsetY);
    const flick =
      distance >= SWIPE_FLICK_DISTANCE &&
      distance / Math.max(1, performance.now() - state.startedAt) >= SWIPE_FLICK_VELOCITY;
    if (state.offsetY < 0 && (distance >= SWIPE_UP_DISTANCE || flick)) onDockModeChange("full");
    else if (state.offsetY > 0 && (distance >= SWIPE_DOWN_DISTANCE || flick)) onDockModeChange("mini");
  };

  const activeScrub = gesture?.axis === "seek" ? gesture : null;
  // The bar follows a swipe at half speed, so it feels attached without leaving the screen.
  const swipeOffset = gesture?.axis === "swipe" ? gesture.offsetY / 2 : 0;
  // A scrub only starts with a known duration, so the percentages are defined while it is active.
  const toPercent = (seconds: number) => (player.duration > 0 ? (seconds / player.duration) * 100 : 0);
  const originProgress = activeScrub ? toPercent(activeScrub.originTime) : 0;
  const previewProgress = activeScrub ? toPercent(activeScrub.previewTime) : 0;
  const changedLeft = Math.min(originProgress, previewProgress);
  const changedWidth = Math.abs(previewProgress - originProgress);
  const scrubDelta = activeScrub ? activeScrub.previewTime - activeScrub.originTime : 0;
  const labelPosition = Math.max(22, Math.min(78, originProgress));

  return (
    <div
      data-player-surface="compact"
      data-compact-player="true"
      className={cn(
        "fixed bottom-[var(--compact-player-mobile-offset)] left-[max(0.75rem,var(--safe-area-left))] right-[max(0.75rem,var(--safe-area-right))] z-40 lg:inset-auto lg:bottom-[var(--compact-player-desktop-offset)] lg:right-6 lg:w-[390px]",
        gesture?.axis !== "swipe" && "transition-transform duration-200 ease-out motion-reduce:transition-none",
      )}
      style={swipeOffset ? { transform: `translateY(${swipeOffset}px)` } : undefined}
    >
      {activeScrub && (
        <div className="pointer-events-none absolute inset-x-0 bottom-full h-12" aria-live="polite">
          <div className="absolute bottom-0 h-7 w-px bg-primary/60" style={{ left: `${originProgress}%` }} />
          <div
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-full bg-popover px-2.5 py-1 text-xs font-medium tabular-nums text-popover-foreground shadow-lg ring-1 ring-border"
            style={{ left: `${labelPosition}%` }}
          >
            {formatScrubTime(activeScrub.originTime)} ({formatScrubTime(activeScrub.previewTime)}){" "}
            <span className={scrubDelta >= 0 ? "text-primary" : "text-destructive"}>
              {formatSignedSeconds(scrubDelta)}
            </span>
          </div>
        </div>
      )}
      <div
        className={cn(
          "relative select-none animate-player-enter overflow-hidden rounded-[var(--player-radius-dock)] bg-card/95 shadow-[0_10px_30px_-10px_hsl(var(--foreground)/0.3)] ring-1 ring-foreground/[0.08] backdrop-blur-2xl dark:bg-card/90 lg:bg-card/80 dark:lg:bg-card/75",
          // Phones keep every pan on the bar for seeking and dock swipes.
          isMobile ? "touch-none" : "touch-pan-y",
        )}
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={(event) => finishGesture(event, true)}
        onPointerCancel={(event) => finishGesture(event, false)}
      >
        {activeScrub && (
          <>
            <div className="absolute inset-y-0 left-0 bg-primary/10" style={{ width: `${changedLeft}%` }} />
            {changedWidth > 0 && (
              <div
                className="absolute inset-y-0 bg-primary/20"
                style={{ left: `${changedLeft}%`, width: `${changedWidth}%` }}
              />
            )}
            <div className="absolute inset-y-0 z-[1] w-px bg-primary/70" style={{ left: `${previewProgress}%` }} />
          </>
        )}
        <div className="relative z-10 flex min-h-[4.25rem] items-center gap-1 py-2 pl-2 pr-1.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-[calc(var(--player-radius-dock)-0.375rem)] p-1 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-foreground/[0.07]"
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              onDockModeChange("full");
            }}
          >
            <CoverImage track={track} className="h-11 w-[3.625rem] rounded-lg shadow-sm" />
            <OverflowMarqueeGroup
              className="min-w-0 flex-1"
              primaryText={trackTitle(track)}
              secondaryText={track.circle || track.workTitle}
              primaryClassName="text-sm font-semibold"
              secondaryClassName="text-xs text-muted-foreground"
            />
          </button>
          <GlyphButton
            data-compact-control
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
            onClick={() => onDockModeChange("mini")}
            aria-label={t("player.mini")}
            title={t("player.mini")}
          >
            <Minimize2 className="h-4 w-4" />
          </GlyphButton>
          <GlyphButton
            data-compact-control
            className="h-11 w-11"
            onClick={player.togglePlay}
            aria-label={player.isPlaying ? t("player.pause") : t("player.play")}
            aria-busy={busy}
            title={busy ? t("common.loading") : undefined}
          >
            <PlayPauseGlyph playing={player.isPlaying} buffering={player.isBuffering} className="h-6 w-6" />
          </GlyphButton>
          <GlyphButton
            data-compact-control
            className="h-11 w-11"
            onClick={player.next}
            disabled={player.currentIndex >= player.queue.length - 1 && player.mode !== "loop"}
            aria-label={t("player.next")}
          >
            <SkipForward className="h-5 w-5" fill="currentColor" />
          </GlyphButton>
        </div>
        <CompactProgressBar duration={player.duration} hidden={Boolean(activeScrub)} currentTimeRef={currentTimeRef} />
      </div>
    </div>
  );
}

/** Swallows the click that ends a gesture, then lets the next one through. */
function suppressNextClick(ref: MutableRefObject<boolean>) {
  ref.current = true;
  window.setTimeout(() => {
    ref.current = false;
  }, 0);
}

/** The thin progress line under the Compact bar; the only part that re-renders with the playback clock. */
function CompactProgressBar({
  duration,
  hidden,
  currentTimeRef,
}: {
  duration: number;
  hidden: boolean;
  currentTimeRef: MutableRefObject<number>;
}) {
  const { currentTime } = usePlayerTime();
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime, currentTimeRef]);
  if (hidden) return null;
  const progress = playbackProgressPercent(currentTime, duration);
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-1 h-[3px] overflow-hidden rounded-full bg-foreground/10">
      <div
        className="h-full origin-left rounded-full bg-primary transition-transform duration-500 ease-linear"
        style={{ transform: `scaleX(${Math.max(0, Math.min(100, progress)) / 100})` }}
      />
    </div>
  );
}

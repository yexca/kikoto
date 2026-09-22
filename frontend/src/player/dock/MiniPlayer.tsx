import { Maximize2, PanelBottom } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { ANDROID_BACK_EVENT } from "@/app/events";
import { cn } from "@/lib/tailwindClassNames";
import type { usePlayer } from "@/player/PlayerProvider";
import type { DockMode, PlayerTrack } from "@/player/playerTypes";

import {
  clampMiniPosition,
  MINI_PLAYER_SIZE,
  miniActionLayout,
  miniRightEdgeX,
  persistMiniPosition,
  restoreMiniPosition,
  safeAreaBottom,
  snapMiniPosition,
  type MiniPosition,
} from "./miniPosition";
import { CoverImage, PlayPauseGlyph } from "./playerControls";

type MiniDrag = { pointerId: number; offsetX: number; offsetY: number; moved: boolean };

export function MiniPlayer({
  player,
  track,
  isMobile,
  progress,
  onDockModeChange,
}: {
  player: ReturnType<typeof usePlayer>;
  track: PlayerTrack;
  isMobile: boolean;
  progress: number;
  onDockModeChange: (mode: DockMode) => void;
}) {
  const { t } = useTranslation();
  const [position, setPosition] = useState<MiniPosition | null>(() => restoreMiniPosition());
  const [actionsOpen, setActionsOpen] = useState(false);
  const dragRef = useRef<MiniDrag | null>(null);
  const actionsTimerRef = useRef<number | null>(null);
  const actions = miniActionLayout(position);
  const busy = player.isPlaying && player.isBuffering;

  const clearActionsTimer = () => {
    if (actionsTimerRef.current !== null) window.clearTimeout(actionsTimerRef.current);
    actionsTimerRef.current = null;
  };

  useEffect(() => {
    if (!actionsOpen || !isMobile) return;
    clearActionsTimer();
    actionsTimerRef.current = window.setTimeout(() => setActionsOpen(false), 3000);
    return clearActionsTimer;
  }, [isMobile, actionsOpen]);

  useEffect(() => clearActionsTimer, []);

  useEffect(() => {
    const handleResize = () => setPosition((current) => (current ? clampMiniPosition(current) : restoreMiniPosition()));
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!isMobile || !actionsOpen) return;
    const handleBack = (event: Event) => {
      setActionsOpen(false);
      event.preventDefault();
    };
    window.addEventListener(ANDROID_BACK_EVENT, handleBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, handleBack);
  }, [actionsOpen, isMobile]);

  const showDesktopActions = () => {
    if (isMobile) return;
    clearActionsTimer();
    setActionsOpen(true);
  };

  const hideDesktopActionsLater = () => {
    if (isMobile) return;
    clearActionsTimer();
    actionsTimerRef.current = window.setTimeout(() => {
      actionsTimerRef.current = null;
      setActionsOpen(false);
    }, 900);
  };

  const stopDrag = (event: ReactPointerEvent) => {
    event.stopPropagation();
  };

  const openMode = (mode: DockMode) => {
    setActionsOpen(false);
    onDockModeChange(mode);
  };

  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (Math.max(0, Math.min(100, progress)) / 100) * circumference;

  return (
    <div
      data-player-surface="mini"
      className={cn("mini-player group fixed z-40 touch-none", actionsOpen && "actions-open")}
      style={
        position
          ? { left: position.x, top: position.y }
          : {
              bottom: isMobile ? "var(--compact-player-mobile-offset)" : "var(--compact-player-desktop-offset)",
              right: "12px",
            }
      }
      onPointerEnter={showDesktopActions}
      onPointerLeave={hideDesktopActionsLater}
      onFocusCapture={showDesktopActions}
      onBlurCapture={hideDesktopActionsLater}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement | null)?.closest("[data-mini-action]")) return;
        const rect = event.currentTarget.getBoundingClientRect();
        dragRef.current = {
          pointerId: event.pointerId,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.moved) setActionsOpen(false);
        const nextX = Math.max(8, Math.min(miniRightEdgeX(), event.clientX - drag.offsetX));
        const bottomLimit = isMobile ? 84 + safeAreaBottom() : 8;
        const nextY = Math.max(
          8,
          Math.min(window.innerHeight - MINI_PLAYER_SIZE - bottomLimit, event.clientY - drag.offsetY),
        );
        if (!drag.moved) {
          const origin = position ?? event.currentTarget.getBoundingClientRect();
          drag.moved = Math.abs(nextX - origin.x) > 4 || Math.abs(nextY - origin.y) > 4;
        }
        setPosition({ x: nextX, y: nextY });
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (!drag) return;
        if (!drag.moved) {
          if (isMobile) setActionsOpen((value) => !value);
          else showDesktopActions();
          return;
        }
        const snapped = snapMiniPosition(event.currentTarget.getBoundingClientRect());
        setPosition(snapped);
        persistMiniPosition(snapped);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <div className="relative h-[92px] w-[92px] animate-player-enter cursor-grab rounded-full bg-card/90 shadow-[0_12px_32px_-8px_hsl(var(--foreground)/0.35)] ring-1 ring-foreground/[0.08] transition-[scale] duration-200 ease-out active:cursor-grabbing active:[scale:0.97] motion-reduce:active:[scale:1]">
        <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            className="text-foreground/10"
          />
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="text-primary transition-[stroke-dashoffset] duration-500 ease-linear"
          />
        </svg>
        <div
          className="pointer-events-none absolute inset-[8px] z-10 overflow-hidden rounded-full bg-background"
          aria-hidden="true"
        >
          <CoverImage track={track} className="h-full w-full rounded-full object-cover" />
        </div>
        <button
          type="button"
          data-mini-action
          className="mini-action absolute left-1/2 top-1/2 z-20 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-background/80 text-foreground shadow-lg ring-1 ring-foreground/10 backdrop-blur-2xl transition-all duration-200 hover:bg-background/95 active:scale-90"
          onPointerDown={stopDrag}
          onPointerUp={stopDrag}
          onClick={(event) => {
            event.stopPropagation();
            player.togglePlay();
          }}
          aria-label={player.isPlaying ? t("player.pause") : t("player.play")}
          aria-busy={busy}
          title={busy ? t("common.loading") : player.isPlaying ? t("player.pause") : t("player.play")}
        >
          <PlayPauseGlyph playing={player.isPlaying} buffering={player.isBuffering} className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-mini-action
          className={cn(
            "mini-action absolute z-20 grid h-10 w-10 place-items-center rounded-full bg-card/95 text-foreground shadow-lg ring-1 ring-foreground/10 transition-all duration-200 hover:text-primary active:scale-90",
            actions.compactClass,
          )}
          onPointerDown={stopDrag}
          onPointerUp={stopDrag}
          onClick={() => openMode("compact")}
          aria-label={t("player.openCompact")}
          title={t("player.compact")}
        >
          <PanelBottom className="h-4 w-4" />
        </button>
        <button
          type="button"
          data-mini-action
          className={cn(
            "mini-action absolute z-20 grid h-10 w-10 place-items-center rounded-full bg-card/95 text-foreground shadow-lg ring-1 ring-foreground/10 transition-all duration-200 hover:text-primary active:scale-90",
            actions.fullClass,
          )}
          onPointerDown={stopDrag}
          onPointerUp={stopDrag}
          onClick={() => openMode("full")}
          aria-label={t("player.openFull")}
          title={t("player.full")}
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

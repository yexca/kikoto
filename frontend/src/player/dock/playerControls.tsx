import { Loader2, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes } from "react";
import { useTranslation } from "react-i18next";

import { assetURL } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import type { PlayerTrack } from "@/player/playerTypes";

import { formatTime } from "./playerFormat";

export function CoverImage({
  track,
  className,
  lazy = false,
}: {
  track: Pick<PlayerTrack, "coverUrl" | "workCode">;
  className: string;
  lazy?: boolean;
}) {
  return track.coverUrl ? (
    <img
      src={assetURL(track.coverUrl)}
      alt=""
      loading={lazy ? "lazy" : undefined}
      decoding="async"
      draggable={false}
      className={cn("shrink-0 bg-muted object-contain", className)}
    />
  ) : (
    <div
      className={cn(
        "grid shrink-0 place-items-center bg-secondary text-sm font-bold text-secondary-foreground",
        className,
      )}
    >
      {track.workCode.slice(0, 2)}
    </div>
  );
}

/**
 * Borderless icon control in the iOS listening style. Hover feedback only
 * appears on fine pointers; press feedback never latches after a tap.
 */
export const GlyphButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }
>(({ className, selected = false, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    data-selected={selected || undefined}
    className={cn(
      "touch-target relative inline-flex shrink-0 select-none items-center justify-center rounded-full text-foreground transition-[transform,background-color,color,opacity] duration-150 hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-90 active:bg-foreground/10 disabled:pointer-events-none disabled:opacity-35 motion-reduce:active:scale-100 data-[selected]:bg-primary/[0.12] data-[selected]:text-primary",
      className,
    )}
    {...props}
  />
));
GlyphButton.displayName = "GlyphButton";

export function PlayPauseGlyph({
  playing,
  buffering,
  className,
}: {
  playing: boolean;
  buffering: boolean;
  className: string;
}) {
  if (playing && buffering) return <Loader2 className={cn("animate-spin", className)} />;
  return playing ? (
    <Pause className={className} fill="currentColor" />
  ) : (
    <Play className={cn("translate-x-[6%]", className)} fill="currentColor" />
  );
}

export function SeekIcon({ direction, seconds }: { direction: "back" | "forward"; seconds: number }) {
  const Icon = direction === "back" ? RotateCcw : RotateCw;
  return (
    <span className="relative inline-flex h-7 w-7 items-center justify-center">
      <Icon className="h-7 w-7" />
      <span className="absolute pt-px text-[9px] font-bold leading-none tabular-nums">{seconds}</span>
    </span>
  );
}

export function SeekBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const { t } = useTranslation();
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const safeCurrentTime = hasDuration
    ? Math.max(0, Math.min(Number.isFinite(currentTime) ? currentTime : 0, duration))
    : 0;
  const [draftValue, setDraftValue] = useState<number | null>(null);
  const [interacting, setInteracting] = useState(false);
  const value = draftValue ?? safeCurrentTime;
  const displayedProgress = hasDuration ? Math.max(0, Math.min(100, (value / duration) * 100)) : 0;

  useEffect(() => {
    if (interacting || draftValue === null || Math.abs(safeCurrentTime - draftValue) > 0.25) return;
    setDraftValue(null);
  }, [draftValue, interacting, safeCurrentTime]);

  return (
    <div className="group/seek relative h-7" data-active={interacting || undefined}>
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/[0.14] transition-[height] duration-200 group-data-[active]/seek:h-2.5">
        <div
          className={cn(
            "h-full origin-left rounded-full bg-foreground/60 group-data-[active]/seek:bg-foreground",
            interacting ? "" : "transition-transform duration-500 ease-linear",
          )}
          style={{ transform: `scaleX(${displayedProgress / 100})` }}
        />
      </div>
      <input
        className="player-scrub absolute inset-0 h-full w-full cursor-pointer disabled:cursor-default"
        data-player-no-drag
        type="range"
        min={0}
        max={hasDuration ? duration : 1}
        step={0.1}
        value={value}
        disabled={!hasDuration}
        onPointerDown={() => {
          setInteracting(true);
          setDraftValue(value);
        }}
        onInput={(event) => {
          const next = Number(event.currentTarget.value);
          setDraftValue(next);
          onSeek(next);
        }}
        onPointerUp={() => setInteracting(false)}
        onPointerCancel={() => setInteracting(false)}
        onBlur={() => setInteracting(false)}
        aria-label={t("player.seek")}
        aria-valuetext={
          hasDuration
            ? t("player.seekPosition", { current: formatTime(value), total: formatTime(duration) })
            : undefined
        }
      />
    </div>
  );
}

/** Three bars that bounce while the row's track is playing. */
export function NowPlayingBars({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <span
      className={cn("player-now-playing inline-flex h-3.5 items-end gap-[2px]", className)}
      data-playing={playing || undefined}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </span>
  );
}

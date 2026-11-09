import {
  Airplay,
  Captions,
  Check,
  Loader2,
  Maximize,
  Minimize,
  PictureInPicture2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { cn } from "@/lib/tailwindClassNames";
import { GlyphButton, PlayPauseGlyph, SeekBar, SeekIcon } from "@/player/mediaControls";
import type { RenderedSubtitleTrack } from "@/features/work-detail/media/useVideoSubtitleTracks";
import { useVideoElementState } from "@/features/work-detail/media/useVideoElementState";
import {
  CONTROLS_HIDE_MS,
  controlsStayVisible,
  cueLineAboveControls,
  formatVideoDuration,
  initialTapState,
  nextTap,
  seekVideoBy,
  seekVideoTo,
  showVideoSubtitle,
  TAP_STREAK_MS,
  tapZone,
  toggleVideoPlayback,
  videoDuration,
} from "@/features/work-detail/media/videoControlsModel";
import { videoFullscreenMode } from "@/features/work-detail/media/videoFullscreen";
import { VIDEO_PLAYBACK_RATES } from "@/features/work-detail/media/videoShortcuts";

type VideoControlsProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  fullscreen: boolean;
  /** The playback info's duration, shown until the element reports its own. */
  fallbackDuration: number;
  /** The video has a source to play. */
  hasSource: boolean;
  subtitles: RenderedSubtitleTrack[];
  seekSteps: { backward: number; forward: number };
  onToggleFullscreen: () => void;
  onRateChange: (rate: number) => void;
};

type Menu = "subtitles" | "rate";
type SeekHint = { zone: "back" | "forward"; total: number };

const trackSelector = "track[data-subtitle-key]";
const interactive = "pointer-events-none group-data-[visible]/controls:pointer-events-auto";

function isFocusVisible(target: EventTarget) {
  try {
    return target instanceof Element && target.matches(":focus-visible");
  } catch {
    return false;
  }
}

type WebKitVideo = HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void };
type VTTCueLike = TextTrackCue & { line: number | "auto"; snapToLines: boolean };

/**
 * The on-screen controls over the video: back, play, and forward in the
 * middle, and the seek bar, time, subtitle and speed menus, mute,
 * picture in picture, AirPlay, and fullscreen along the bottom. A touch tap
 * shows or hides them, and a double tap on either side seeks; a mouse click
 * plays or pauses, and a double click toggles fullscreen. While the video
 * plays they fade out a few seconds after the last interaction.
 */
export function VideoControls({
  videoRef,
  stageRef,
  fullscreen,
  fallbackDuration,
  hasSource,
  subtitles,
  seekSteps,
  onToggleFullscreen,
  onRateChange,
}: VideoControlsProps) {
  const { t } = useTranslation();
  const state = useVideoElementState(videoRef);
  const [shown, setShown] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [seekHint, setSeekHint] = useState<SeekHint | null>(null);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);
  const [pictureInPictureAvailable, setPictureInPictureAvailable] = useState(false);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const tapRef = useRef(initialTapState);
  const pointerRef = useRef<{ type: string; menuOpen: boolean } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const movedCuesRef = useRef(new WeakSet<TextTrackCue>());

  const playing = !state.paused;
  const busy = playing && (state.waiting || !state.ready);
  const pinned = controlsStayVisible({ playing, busy, menuOpen: menu !== null, keyboardFocus, hovering });
  const visible = shown || pinned;
  const duration = videoDuration(state.duration, fallbackDuration);
  const canSeek = hasSource && state.ready;

  const reveal = useCallback(() => {
    setShown(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setShown(false), CONTROLS_HIDE_MS);
  }, []);
  const conceal = useCallback(() => {
    window.clearTimeout(hideTimerRef.current);
    setShown(false);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  // The hide timer starts over whenever nothing holds the controls on screen any more.
  useEffect(() => {
    if (!pinned) reveal();
  }, [pinned, reveal]);

  useEffect(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return;
    setFullscreenAvailable(videoFullscreenMode(stage, video) !== null);
    setPictureInPictureAvailable(
      document.pictureInPictureEnabled === true &&
        typeof video.requestPictureInPicture === "function" &&
        !video.disablePictureInPicture,
    );
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") reveal();
    };
    const handlePointerLeave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setHovering(false);
    };
    stage.addEventListener("pointermove", handlePointerMove);
    stage.addEventListener("pointerleave", handlePointerLeave);
    stage.addEventListener("keydown", reveal);
    return () => {
      stage.removeEventListener("pointermove", handlePointerMove);
      stage.removeEventListener("pointerleave", handlePointerLeave);
      stage.removeEventListener("keydown", reveal);
    };
  }, [reveal, stageRef, videoRef]);

  useEffect(() => {
    if (!seekHint) return;
    const timer = window.setTimeout(() => setSeekHint(null), TAP_STREAK_MS);
    return () => window.clearTimeout(timer);
  }, [seekHint]);

  // Automatically placed subtitles move up above the bottom bar while it shows.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const moved = movedCuesRef.current;
    const place = () => {
      const line = visible ? cueLineAboveControls(video.clientHeight, bottomRef.current?.offsetHeight ?? 0) : null;
      for (const track of Array.from(video.textTracks)) {
        if (track.mode !== "showing") continue;
        for (const cue of Array.from(track.activeCues ?? []) as VTTCueLike[]) {
          // Cues the subtitle file positions itself stay where it put them.
          if (!("line" in cue) || (!moved.has(cue) && cue.line !== "auto")) continue;
          if (line === null) moved.delete(cue);
          else moved.add(cue);
          const next = line ?? "auto";
          if (cue.line === next && cue.snapToLines) continue;
          cue.snapToLines = true;
          cue.line = next;
          // A paused video does not redraw a changed cue that is already showing until it is added again.
          track.removeCue(cue);
          track.addCue(cue);
        }
      }
    };
    place();
    // A track element's cuechange does not bubble, so the video listens in the capture phase.
    video.addEventListener("cuechange", place, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(video);
    return () => {
      video.removeEventListener("cuechange", place, true);
      observer?.disconnect();
    };
  }, [videoRef, visible]);

  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (video && canSeek) seekVideoBy(video, seconds, fallbackDuration);
  };

  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerRef.current = { type: event.pointerType, menuOpen: menu !== null };
  };

  const handleSurfacePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = pointerRef.current;
    if (!down || down.menuOpen || event.pointerType === "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const result = nextTap(
      tapRef.current,
      { at: event.timeStamp, zone: tapZone(event.clientX - rect.left, rect.width), controlsVisible: visible },
      seekSteps,
    );
    tapRef.current = result.state;
    const action = result.action;
    if (action.kind === "toggle") {
      if (visible) conceal();
      else reveal();
      return;
    }
    if (action.visible === true) reveal();
    else if (action.visible === false) conceal();
    if (action.kind === "seek") {
      seekBy(action.seconds);
      setSeekHint({ zone: action.zone, total: action.total });
    }
  };

  const mouseGesture = () => pointerRef.current?.type === "mouse" && !pointerRef.current.menuOpen;

  const shownSubtitle = subtitles.find((track) => track.key === state.subtitleKey) ?? null;
  const chooseSubtitle = (key: string | null) => {
    const video = videoRef.current;
    if (video) showVideoSubtitle(video.querySelectorAll<HTMLTrackElement>(trackSelector), key);
  };

  return (
    <>
      {/* The gesture surface lies under the controls, so a press on a control never reaches it. */}
      <div
        className="absolute inset-0 touch-manipulation select-none"
        aria-hidden="true"
        onPointerDown={handleSurfacePointerDown}
        onPointerUp={handleSurfacePointerUp}
        onClick={() => {
          const video = videoRef.current;
          if (video && hasSource && mouseGesture()) toggleVideoPlayback(video);
        }}
        onDoubleClick={() => {
          if (mouseGesture()) onToggleFullscreen();
        }}
      />
      {seekHint && (
        <div
          className={cn(
            "pointer-events-none absolute inset-y-0 flex w-1/3 items-center justify-center",
            seekHint.zone === "back" ? "left-0" : "right-0",
          )}
          role="status"
        >
          <span className="rounded-full bg-scrim/60 px-3 py-1.5 text-sm font-medium tabular-nums text-foreground">
            {seekHint.zone === "back"
              ? t("videoPlayback.seekBackHint", { seconds: -seekHint.total })
              : t("videoPlayback.seekForwardHint", { seconds: seekHint.total })}
          </span>
        </div>
      )}
      <div
        data-visible={visible || undefined}
        className="group/controls pointer-events-none absolute inset-0 flex flex-col opacity-0 transition-opacity duration-200 data-[visible]:opacity-100 motion-reduce:transition-none"
        onFocus={(event) => {
          reveal();
          setKeyboardFocus(isFocusVisible(event.target));
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocus(false);
        }}
      >
        <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-scrim/50 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-scrim/80 via-scrim/40 to-transparent" />
        {/* The middle keeps clear of the bottom bar, so a short frame never stacks them. */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <div
            className={cn("flex items-center gap-5 sm:gap-10", interactive)}
            onPointerEnter={(event) => event.pointerType === "mouse" && setHovering(true)}
            onPointerLeave={(event) => event.pointerType === "mouse" && setHovering(false)}
          >
            <GlyphButton
              className="h-11 w-11 bg-scrim/30 sm:h-12 sm:w-12"
              aria-label={t("player.backward", { seconds: seekSteps.backward })}
              disabled={!canSeek}
              onClick={() => seekBy(-seekSteps.backward)}
            >
              <SeekIcon direction="back" seconds={seekSteps.backward} />
            </GlyphButton>
            <GlyphButton
              className="h-14 w-14 bg-scrim/40 sm:h-16 sm:w-16"
              aria-label={playing ? t("player.pause") : t("player.play")}
              disabled={!hasSource}
              onClick={() => {
                const video = videoRef.current;
                if (video) toggleVideoPlayback(video);
              }}
            >
              <PlayPauseGlyph playing={playing} buffering={busy} className="h-7 w-7 sm:h-8 sm:w-8" />
            </GlyphButton>
            <GlyphButton
              className="h-11 w-11 bg-scrim/30 sm:h-12 sm:w-12"
              aria-label={t("player.forward", { seconds: seekSteps.forward })}
              disabled={!canSeek}
              onClick={() => seekBy(seekSteps.forward)}
            >
              <SeekIcon direction="forward" seconds={seekSteps.forward} />
            </GlyphButton>
          </div>
        </div>
        <div
          ref={bottomRef}
          className="relative pb-[max(0.25rem,var(--safe-area-bottom))] pl-[max(0.75rem,var(--safe-area-left))] pr-[max(0.75rem,var(--safe-area-right))]"
        >
          <div
            className={interactive}
            onPointerEnter={(event) => event.pointerType === "mouse" && setHovering(true)}
            onPointerLeave={(event) => event.pointerType === "mouse" && setHovering(false)}
          >
            <SeekBar
              currentTime={state.currentTime}
              duration={duration}
              buffered={state.buffered}
              disabled={!canSeek}
              onSeek={(seconds) => {
                const video = videoRef.current;
                if (video && canSeek) seekVideoTo(video, seconds, fallbackDuration);
              }}
            />
            <div className="flex items-center gap-0.5">
              <span className="min-w-0 truncate px-1 text-xs tabular-nums text-foreground">
                {formatVideoDuration(state.currentTime)} / {formatVideoDuration(duration)}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-0.5">
                {subtitles.length > 0 && (
                  <ControlMenu
                    label={t("videoPlayback.subtitles")}
                    trigger={<Captions className={cn("h-5 w-5", !shownSubtitle && "opacity-60")} />}
                    selected={shownSubtitle !== null}
                    open={menu === "subtitles"}
                    onOpenChange={(open) => setMenu(open ? "subtitles" : null)}
                    container={fullscreen ? stageRef.current : null}
                    options={[
                      { key: "", label: t("videoPlayback.subtitlesOff"), checked: shownSubtitle === null },
                      ...subtitles.map((track) => ({
                        key: track.key,
                        label: track.label,
                        checked: track.key === shownSubtitle?.key,
                        loading: track.status === "loading",
                        hint:
                          track.status === "loading"
                            ? t("videoPlayback.subtitleLoading")
                            : track.status === "failed"
                              ? t("videoPlayback.subtitleFailed")
                              : undefined,
                      })),
                    ]}
                    onSelect={(key) => chooseSubtitle(key || null)}
                  />
                )}
                <ControlMenu
                  label={t("player.playbackSpeed")}
                  trigger={<span className="text-xs font-semibold tabular-nums">{`${state.rate}×`}</span>}
                  selected={state.rate !== 1}
                  open={menu === "rate"}
                  onOpenChange={(open) => setMenu(open ? "rate" : null)}
                  container={fullscreen ? stageRef.current : null}
                  options={VIDEO_PLAYBACK_RATES.map((rate) => ({
                    key: String(rate),
                    label: `${rate}×`,
                    checked: Math.abs(rate - state.rate) < 0.001,
                  }))}
                  onSelect={(key) => onRateChange(Number(key))}
                />
                <GlyphButton
                  className="h-10 w-10"
                  aria-label={state.muted ? t("videoPlayback.unmute") : t("videoPlayback.mute")}
                  onClick={() => {
                    const video = videoRef.current;
                    if (video) video.muted = !video.muted;
                  }}
                >
                  {state.muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </GlyphButton>
                {pictureInPictureAvailable && (
                  <GlyphButton
                    className="hidden h-10 w-10 @md/video:inline-flex"
                    aria-label={
                      state.pictureInPicture
                        ? t("videoPlayback.exitPictureInPicture")
                        : t("videoPlayback.pictureInPicture")
                    }
                    selected={state.pictureInPicture}
                    disabled={!canSeek}
                    onClick={() => {
                      const video = videoRef.current;
                      if (!video) return;
                      if (document.pictureInPictureElement === video) {
                        void document.exitPictureInPicture().catch(() => undefined);
                      } else {
                        void video.requestPictureInPicture().catch(() => undefined);
                      }
                    }}
                  >
                    <PictureInPicture2 className="h-5 w-5" />
                  </GlyphButton>
                )}
                {state.airPlayAvailable && (
                  <GlyphButton
                    className="hidden h-10 w-10 @md/video:inline-flex"
                    aria-label={t("videoPlayback.airPlay")}
                    onClick={() => (videoRef.current as WebKitVideo | null)?.webkitShowPlaybackTargetPicker?.()}
                  >
                    <Airplay className="h-5 w-5" />
                  </GlyphButton>
                )}
                {fullscreenAvailable && (
                  <GlyphButton
                    className="h-10 w-10"
                    aria-label={fullscreen ? t("videoPlayback.exitFullscreen") : t("videoPlayback.fullscreen")}
                    onClick={onToggleFullscreen}
                  >
                    {fullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                  </GlyphButton>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

type MenuOption = { key: string; label: string; checked: boolean; loading?: boolean; hint?: string };

/** A control that opens a single-choice menu above it, rendered into `container` while that is fullscreen. */
function ControlMenu({
  label,
  trigger,
  selected,
  open,
  onOpenChange,
  container,
  options,
  onSelect,
}: {
  label: string;
  trigger: ReactNode;
  selected: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: Element | null;
  options: MenuOption[];
  onSelect: (key: string) => void;
}) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]');
      (checked ?? items?.[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    onOpenChange(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <GlyphButton
        ref={buttonRef}
        className="h-10 min-w-10 px-1"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        selected={selected}
        onClick={() => onOpenChange(!open)}
      >
        {trigger}
      </GlyphButton>
      <AnchoredPopover
        open={open}
        anchorRef={buttonRef}
        onOpenChange={(next) => {
          // The popover closes on Escape before the menu sees the key, so focus returns here.
          if (!next && menuRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
          onOpenChange(next);
        }}
        container={container}
        floatingLayer
        // The menus share the video area's dark scope, inline and fullscreen alike.
        className="dark w-[min(16rem,calc(100vw-1.5rem))] p-1 text-sm"
        zIndex={70}
      >
        <div id={menuId} ref={menuRef} role="menu" aria-label={label} onKeyDown={handleKeyDown}>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitemradio"
              aria-checked={option.checked}
              aria-busy={option.loading || undefined}
              tabIndex={-1}
              className="flex min-h-11 w-full items-start gap-2 rounded px-2 py-2 text-left hover:bg-muted focus:bg-muted focus:outline-none sm:min-h-9"
              onClick={() => {
                onSelect(option.key);
                close(true);
              }}
            >
              <span className="mt-0.5 h-4 w-4 shrink-0 text-primary">
                {option.loading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  option.checked && <Check className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.hint && <span className="block text-xs text-muted-foreground">{option.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}

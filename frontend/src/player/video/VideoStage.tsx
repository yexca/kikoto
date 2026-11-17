import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { useStableCallback } from "@/hooks/useStableCallback";
import { assetURL, type VideoEmbeddedSubtitle, type VideoPlaybackInfo } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { attachPlaybackSource, type PlaybackSourceFailure } from "@/player/attachPlaybackSource";
import { usePlaybackSeekPreferences } from "@/player/mediaControls";
import { retriesRemuxAsTranscode } from "@/player/videoPlaybackModel";

import { useVideoSubtitleTracks } from "./useVideoSubtitleTracks";
import { VideoControls } from "./VideoControls";
import { formatVideoDuration } from "./videoControlsModel";
import { toggleVideoFullscreen, useStageFullscreen, videoFullscreenMode } from "./videoFullscreen";
import { videoLandscapeLock, watchVideoFullscreenOrientation } from "./videoFullscreenOrientation";
import { handleVideoStageKeyDown } from "./videoShortcuts";
import type { VideoSubtitle } from "./videoSubtitles";

/** Where a source starts, and whether it plays once it can. */
export type VideoStageStart = { position: number; playing: boolean };

/**
 * Why the stage's source stopped. `direct` is an original file the browser
 * could not play and `transcode` a remux its decoder rejected; the caller may
 * prepare either again as a conversion. `restoreFailed` is a start position
 * the new source refused. The others are those of `attachPlaybackSource`.
 */
export type VideoStageFailure = PlaybackSourceFailure | "direct" | "restoreFailed";

/**
 * A position the stage reports for the caller's resume store. `leave` is the
 * page hiding or the stage closing; it carries the last settled position when
 * the source is between loads.
 */
export type VideoStagePosition = {
  position: number;
  duration: number | undefined;
  moment: "time" | "seeked" | "pause" | "ended" | "leave";
};

export type VideoStageHandle = {
  /** The stage's shortcuts, for a surrounding element that keeps focus instead of the stage. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  /** Pauses, also for a source that is still loading. */
  pause: () => void;
  /** Keeps the position and play state for the next source, and ignores the pause the change causes. */
  holdForNewSource: () => void;
  /** Moves to a position; before a source loads, it becomes where that source starts. */
  seekTo: (position: number) => void;
  /** Where playback stands, or the position the next source starts at. */
  currentTime: () => number;
};

// A stable empty list, so the subtitle tracks do not treat each render as new playback info.
const noEmbeddedSubtitles: VideoEmbeddedSubtitle[] = [];
const rateNoticeMilliseconds = 1500;

function finiteDuration(value: number) {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A position the viewer reached: the source has loaded and holds no pending start. */
function settledPosition(video: HTMLVideoElement, changingSource: boolean, pending: VideoStageStart | null) {
  if (changingSource || pending || video.readyState === 0) return null;
  return Number.isFinite(video.currentTime) ? video.currentTime : null;
}

/**
 * The video stage of both the work file preview and the Record player: the
 * element, its controls, shortcuts, subtitle menu, playback rate, and
 * fullscreen, and the source that playback info chose. A failed or changed
 * source starts the next one where the last stopped, in the same play state.
 * `inline` sizes the video to the page width; `fill` fits it to the space the
 * stage is given. Remount it per file (`key`).
 */
export function VideoStage({
  ref,
  playback,
  start = null,
  subtitles,
  fallbackDuration,
  poster,
  layout,
  controls = true,
  enterFullscreen = false,
  onFailure,
  onPlay,
  onPlaying,
  onPosition,
  children,
}: {
  ref?: Ref<VideoStageHandle>;
  /** The source to play, or null while it is prepared or after it failed. */
  playback: VideoPlaybackInfo | null;
  /** Where the first source starts; read when it attaches. */
  start?: VideoStageStart | null;
  /** Sidecar subtitle files; keep the list stable between renders. */
  subtitles: VideoSubtitle[];
  fallbackDuration: number;
  poster?: string;
  layout: "inline" | "fill";
  /** Whether the on-screen controls show. */
  controls?: boolean;
  /** Enters fullscreen once when this turns true; the tap that caused it allows the request. */
  enterFullscreen?: boolean;
  onFailure: (failure: VideoStageFailure) => void;
  onPlay?: () => void;
  onPlaying?: () => void;
  onPosition?: (report: VideoStagePosition) => void;
  /** Shown below the video, or over it in the `fill` layout; it stays inside the stage in fullscreen. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fullscreen = useStageFullscreen(stageRef);
  const seekPreferences = usePlaybackSeekPreferences(useAuth().user?.id ?? null);
  const [rateNotice, setRateNotice] = useState<number | null>(null);
  const subtitleTracks = useVideoSubtitleTracks(
    videoRef,
    subtitles,
    playback ? (playback.subtitles ?? noEmbeddedSubtitles) : null,
  );
  const fail = useStableCallback(onFailure);
  const report = useStableCallback((value: VideoStagePosition) => onPosition?.(value));

  const firstStart = useStableCallback(() => start);
  // Whether a source has attached, and where a seek before that moves the first start.
  const startedRef = useRef(false);
  const seekBeforeStartRef = useRef<number | null>(null);
  // Where the next source starts and whether it plays; null once a source applied it.
  const pendingRef = useRef<VideoStageStart | null>(null);
  const wantsPlaybackRef = useRef(false);
  // Set while a source loads or reloads, so its pauses and positions are not the viewer's.
  const changingSourceRef = useRef(false);
  const hlsJsRef = useRef(false);
  const generationRef = useRef(0);
  const lastPositionRef = useRef<number | null>(null);

  const displayedDuration = playback?.durationSeconds || fallbackDuration;
  const durationOf = useStableCallback(
    (video: HTMLVideoElement) => finiteDuration(video.duration) ?? (displayedDuration || undefined),
  );

  const remember = useCallback(() => {
    const video = videoRef.current;
    if (!video || pendingRef.current) return;
    pendingRef.current = {
      position: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      playing: wantsPlaybackRef.current,
    };
  }, []);

  const note = (video: HTMLVideoElement, moment: VideoStagePosition["moment"]) => {
    const position = settledPosition(video, changingSourceRef.current, pendingRef.current);
    if (position === null) return;
    lastPositionRef.current = position;
    report({ position, duration: durationOf(video), moment });
  };

  // Hiding the page or closing the stage reports where it stood. This effect is declared before the
  // source effect, so on close it runs while the element still has its source.
  useEffect(() => {
    const video = videoRef.current;
    const leave = () => {
      const position =
        (video && settledPosition(video, changingSourceRef.current, pendingRef.current)) ?? lastPositionRef.current;
      if (position === null) return;
      report({ position, duration: video ? durationOf(video) : undefined, moment: "leave" });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [durationOf, report]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback?.url) return;
    const beginChange = () => {
      generationRef.current++;
      changingSourceRef.current = true;
      hlsJsRef.current = false;
    };
    beginChange();
    if (!startedRef.current) {
      startedRef.current = true;
      const first = firstStart();
      const position = seekBeforeStartRef.current ?? first?.position;
      pendingRef.current = position === undefined ? null : { position, playing: first?.playing ?? false };
      wantsPlaybackRef.current = first?.playing ?? false;
    }
    const detach = attachPlaybackSource(video, playback, {
      startPosition: pendingRef.current?.position,
      onHlsJs: () => {
        hlsJsRef.current = true;
      },
      onRecover: () => {
        remember();
        changingSourceRef.current = true;
      },
      onFailure: (failure) => {
        remember();
        fail(failure);
      },
    });
    return () => {
      beginChange();
      detach();
    };
  }, [fail, firstStart, playback, remember]);

  useEffect(() => {
    const video = videoRef.current;
    const landscape = videoLandscapeLock();
    if (!video || !landscape) return;
    return watchVideoFullscreenOrientation(video, document, landscape);
  }, []);

  const enteredFullscreen = useRef(false);
  useEffect(() => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!enterFullscreen || enteredFullscreen.current || !stage || !video) return;
    if (videoFullscreenMode(stage, video) !== "stage" || document.fullscreenElement) return;
    enteredFullscreen.current = true;
    toggleVideoFullscreen(stage, video);
  }, [enterFullscreen]);

  useEffect(() => {
    if (rateNotice === null) return;
    const timer = window.setTimeout(() => setRateNotice(null), rateNoticeMilliseconds);
    return () => window.clearTimeout(timer);
  }, [rateNotice]);

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (stage && video) toggleVideoFullscreen(stage, video);
  };
  const changeRate = (rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setRateNotice(video.playbackRate);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) =>
    handleVideoStageKeyDown(event, videoRef.current, {
      duration: displayedDuration,
      toggleFullscreen,
      changeRate,
    });

  useImperativeHandle(ref, () => ({
    handleKeyDown,
    pause: () => {
      wantsPlaybackRef.current = false;
      if (pendingRef.current) pendingRef.current.playing = false;
      videoRef.current?.pause();
    },
    holdForNewSource: () => {
      remember();
      changingSourceRef.current = true;
      videoRef.current?.pause();
    },
    seekTo: (position) => {
      const video = videoRef.current;
      lastPositionRef.current = position;
      if (!startedRef.current) seekBeforeStartRef.current = position;
      else if (pendingRef.current) pendingRef.current.position = position;
      else if (video && video.readyState > 0) video.currentTime = position;
    },
    currentTime: () => {
      const video = videoRef.current;
      if (pendingRef.current) return pendingRef.current.position;
      return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    },
  }));

  const fill = layout === "fill";
  return (
    <div
      ref={stageRef}
      className={cn(
        "relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        fill ? "flex min-h-0 flex-1 items-center justify-center" : "w-full",
        fullscreen && (fill ? "h-full bg-black" : "flex h-full flex-col bg-black"),
      )}
      role="group"
      aria-label={t("videoPlayback.player")}
      aria-keyshortcuts="Space K J L ArrowLeft ArrowRight F M Shift+< Shift+>"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div
        className={cn(
          "@container/video",
          fill ? "absolute inset-0" : "relative",
          fullscreen && !fill && "min-h-0 flex-1",
        )}
      >
        <video
          ref={videoRef}
          playsInline
          preload="metadata"
          poster={poster ? assetURL(poster) : undefined}
          className={cn(
            fill
              ? "absolute inset-0 h-full w-full object-contain"
              : cn("block w-full bg-black object-contain", fullscreen ? "h-full" : "max-h-[72vh]"),
          )}
          aria-label={
            displayedDuration > 0
              ? t("videoPlayback.previewDuration", { duration: formatVideoDuration(displayedDuration) })
              : t("videoPlayback.preview")
          }
          onPlay={() => {
            wantsPlaybackRef.current = true;
            if (pendingRef.current) pendingRef.current.playing = true;
            onPlay?.();
          }}
          onPause={(event) => {
            const video = event.currentTarget;
            if (changingSourceRef.current || video.error) return;
            wantsPlaybackRef.current = false;
            if (pendingRef.current) pendingRef.current.playing = false;
            // An ending reports itself.
            if (!video.ended) note(video, "pause");
          }}
          onEnded={(event) => {
            wantsPlaybackRef.current = false;
            note(event.currentTarget, "ended");
          }}
          onTimeUpdate={(event) => note(event.currentTarget, "time")}
          onSeeked={(event) => note(event.currentTarget, "seeked")}
          onLoadedMetadata={(event) => {
            changingSourceRef.current = false;
            const pending = pendingRef.current;
            if (!pending) return;
            const video = event.currentTarget;
            // hls.js may already have started at an earlier pending position.
            if (pending.position > 0 || video.currentTime > 0) {
              const end = Number.isFinite(video.duration) ? video.duration : pending.position;
              try {
                video.currentTime = Math.min(pending.position, end);
              } catch {
                fail("restoreFailed");
                return;
              }
            }
            pendingRef.current = null;
            if (!pending.playing) return;
            const generation = generationRef.current;
            void video.play().catch((reason: unknown) => {
              if (generation !== generationRef.current) return;
              // Autoplay can be refused, and a newer load interrupts this one; the controls still start playback.
              if (
                reason instanceof DOMException &&
                (reason.name === "NotAllowedError" || reason.name === "AbortError")
              ) {
                return;
              }
              remember();
              fail("playFailed");
            });
          }}
          onPlaying={onPlaying}
          onError={() => {
            if (!playback || (playback.delivery === "hls" && hlsJsRef.current)) return;
            remember();
            fail(
              playback.delivery === "direct"
                ? "direct"
                : retriesRemuxAsTranscode(playback)
                  ? "transcode"
                  : "playFailed",
            );
          }}
        >
          {subtitleTracks.map((track) => (
            <track
              key={track.key}
              data-subtitle-key={track.key}
              kind="subtitles"
              src={track.src}
              srcLang={track.language}
              label={track.label}
            />
          ))}
        </video>
        {controls && (
          <VideoControls
            videoRef={videoRef}
            stageRef={stageRef}
            fullscreen={fullscreen}
            fallbackDuration={displayedDuration}
            hasSource={Boolean(playback?.url)}
            subtitles={subtitleTracks}
            seekSteps={{
              backward: seekPreferences.seekBackwardSeconds,
              forward: seekPreferences.seekForwardSeconds,
            }}
            onToggleFullscreen={toggleFullscreen}
            onRateChange={changeRate}
          />
        )}
        {rateNotice !== null && (
          <div
            className="pointer-events-none absolute right-3 top-3 rounded-md bg-background/80 px-2.5 py-1 text-sm tabular-nums text-foreground backdrop-blur"
            role="status"
          >
            {t("videoPlayback.playbackRate", { rate: rateNotice })}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

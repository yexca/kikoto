import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, assetURL, type VideoAudioTrack, type VideoEmbeddedSubtitle, type VideoPlaybackInfo } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { usePlaybackSeekPreferences } from "@/player/mediaControls";
import { playbackURL, prefersNativeVideoHls, videoPlaybackCapabilities } from "@/player/mediaPlayback";
import { VideoControls } from "@/features/work-detail/media/VideoControls";
import { formatVideoDuration, seekVideoBy, toggleVideoPlayback } from "@/features/work-detail/media/videoControlsModel";
import { toggleVideoFullscreen, useStageFullscreen } from "@/features/work-detail/media/videoFullscreen";
import {
  CONSERVATIVE_HLS_CONFIG,
  prepareVideoPlayback,
  retriesRemuxAsTranscode,
  videoPlaybackFailureKey,
} from "@/features/work-detail/media/videoPlaybackModel";
import {
  readVideoResumePosition,
  videoResumeStorageKey,
  writeVideoResumePosition,
} from "@/features/work-detail/media/videoResume";
import {
  chooseVideoAudioStream,
  chosenVideoAudioStream,
  forgetChosenVideoAudioStream,
  rejectsVideoAudioStream,
  videoAudioTrackChoices,
  videoAudioTrackLabel,
} from "@/features/work-detail/media/videoAudioTracks";
import {
  videoLandscapeLock,
  watchVideoFullscreenOrientation,
} from "@/features/work-detail/media/videoFullscreenOrientation";
import { nextVideoPlaybackRate, videoShortcut } from "@/features/work-detail/media/videoShortcuts";
import { useVideoSubtitleTracks } from "@/features/work-detail/media/useVideoSubtitleTracks";
import type { VideoSubtitle } from "@/features/work-detail/media/videoSubtitles";

type VideoPreviewProps = {
  locationId: number;
  fallbackUrl: string;
  durationSeconds: number | null;
  canTranscode: boolean;
  subtitles?: VideoSubtitle[];
  pauseRequested: boolean;
  onPlay: () => void;
};

const noSubtitles: VideoSubtitle[] = [];
const noEmbeddedSubtitles: VideoEmbeddedSubtitle[] = [];
// While playing, the stored resume position follows the video in steps of this many seconds.
const resumeWriteIntervalSeconds = 5;
const rateNoticeMilliseconds = 1500;

export function VideoPreview(props: VideoPreviewProps) {
  return <VideoPlayback key={`${props.locationId}:${props.fallbackUrl}`} {...props} />;
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function VideoPlayback({
  locationId,
  fallbackUrl,
  durationSeconds,
  canTranscode,
  subtitles = noSubtitles,
  pauseRequested,
  onPlay,
}: VideoPreviewProps) {
  const { t, i18n } = useTranslation();
  const auth = useAuth();
  const principalID = auth.user?.id ?? null;
  const resumeStorageKey = videoResumeStorageKey(principalID);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fullscreen = useStageFullscreen(stageRef);
  const seekPreferences = usePlaybackSeekPreferences(principalID);
  const [playback, setPlayback] = useState<VideoPlaybackInfo | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // The audio track chosen in this page session; null plays the default track.
  const [audioStream, setAudioStream] = useState(() => chosenVideoAudioStream(principalID, locationId));
  const [audioTracks, setAudioTracks] = useState<VideoAudioTrack[]>([]);
  const [error, setError] = useState("");
  const [resumedFrom, setResumedFrom] = useState(() => {
    const storage = browserStorage();
    return storage ? readVideoResumePosition(storage, resumeStorageKey, locationId) : null;
  });
  const [rateNotice, setRateNotice] = useState<number | null>(null);
  const subtitleTracks = useVideoSubtitleTracks(
    videoRef,
    subtitles,
    playback ? (playback.subtitles ?? noEmbeddedSubtitles) : null,
  );
  const wantsPlaybackRef = useRef(false);
  const changingSourceRef = useRef(false);
  const hlsManagedRef = useRef(false);
  const sourceGenerationRef = useRef(0);
  // The first source starts at the stored resume position, paused.
  const recoveryRef = useRef<{ position: number; playing: boolean } | null>(
    resumedFrom === null ? null : { position: resumedFrom, playing: false },
  );
  const positionRef = useRef<{ current: number | null; written: number | null }>({
    current: null,
    written: resumedFrom,
  });

  const rememberPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || recoveryRef.current) return;
    recoveryRef.current = {
      position: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      playing: wantsPlaybackRef.current,
    };
  }, []);

  const displayedDuration = playback?.durationSeconds || durationSeconds || 0;

  const writeResumePosition = useStableCallback((position: number) => {
    const storage = browserStorage();
    if (!storage) return;
    const video = videoRef.current;
    const duration =
      video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : displayedDuration;
    writeVideoResumePosition(storage, resumeStorageKey, locationId, position, duration);
    positionRef.current.written = position;
  });

  // Notes where the video is once its start position applies, and stores it every few seconds or when forced.
  const notePosition = useCallback(
    (video: HTMLVideoElement, force = false) => {
      if (changingSourceRef.current || recoveryRef.current || video.readyState === 0) return false;
      const position = video.currentTime;
      if (!Number.isFinite(position)) return false;
      positionRef.current.current = position;
      const written = positionRef.current.written;
      if (force || written === null || Math.abs(position - written) >= resumeWriteIntervalSeconds) {
        writeResumePosition(position);
      }
      return true;
    },
    [writeResumePosition],
  );

  // Closing the viewer, stepping to another file, or hiding the page stores the current position. This
  // effect is declared before the source effect, so on close it runs while the element still has its
  // source, even when a seek has not reported `seeked` yet.
  useEffect(() => {
    const video = videoRef.current;
    const positions = positionRef.current;
    const flush = () => {
      if (video && notePosition(video, true)) return;
      if (positions.current !== null && positions.current !== positions.written) writeResumePosition(positions.current);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [notePosition, writeResumePosition]);

  useEffect(() => {
    if (rateNotice === null) return;
    const timer = window.setTimeout(() => setRateNotice(null), rateNoticeMilliseconds);
    return () => window.clearTimeout(timer);
  }, [rateNotice]);

  useEffect(() => {
    const video = videoRef.current;
    const landscape = videoLandscapeLock();
    if (!video || !landscape) return;
    return watchVideoFullscreenOrientation(video, document, landscape);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    if (!canTranscode || locationId <= 0) {
      setPlayback({
        delivery: "direct",
        url: playbackURL(fallbackUrl, "video"),
        durationSeconds: durationSeconds ?? 0,
        seekable: true,
      });
      return () => controller.abort();
    }
    setPlayback(null);
    void prepareVideoPlayback(
      async () =>
        api.getVideoPlaybackInfo(
          locationId,
          await videoPlaybackCapabilities(),
          forceTranscode,
          controller.signal,
          audioStream,
        ),
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setAudioTracks(videoAudioTrackChoices(value));
        setPlayback(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (audioStream !== null && rejectsVideoAudioStream(reason)) {
          forgetChosenVideoAudioStream(principalID, locationId);
          setAudioStream(null);
          return;
        }
        setError(videoPlaybackFailureKey(reason));
      });
    return () => controller.abort();
  }, [audioStream, canTranscode, durationSeconds, fallbackUrl, forceTranscode, locationId, principalID, retryToken]);

  useEffect(() => {
    if (!pauseRequested) return;
    wantsPlaybackRef.current = false;
    if (recoveryRef.current) recoveryRef.current.playing = false;
    videoRef.current?.pause();
  }, [pauseRequested]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback?.url) return;
    let active = true;
    let instance: Hls | null = null;
    const sourceURL = assetURL(playback.url);

    const clearSource = () => {
      sourceGenerationRef.current++;
      changingSourceRef.current = true;
      hlsManagedRef.current = false;
      video.removeAttribute("src");
      video.load();
    };
    clearSource();
    // iOS and iPadOS play HLS natively, which keeps native fullscreen and AirPlay.
    if (playback.delivery === "direct" || prefersNativeVideoHls(video)) {
      video.src = sourceURL;
      video.load();
      return clearSource;
    }

    void import("hls.js")
      .then(({ default: HlsConstructor }) => {
        if (!active) return;
        if (HlsConstructor.isSupported()) {
          let mediaRecoveryAttempts = 0;
          hlsManagedRef.current = true;
          instance = new HlsConstructor({
            ...CONSERVATIVE_HLS_CONFIG,
            startPosition: recoveryRef.current?.position ?? -1,
          });
          instance.on(HlsConstructor.Events.ERROR, (_event: string, data: ErrorData) => {
            if (!data.fatal || !instance || !active) return;
            rememberPlayback();
            if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 1) {
              mediaRecoveryAttempts++;
              changingSourceRef.current = true;
              instance.recoverMediaError();
              return;
            }
            instance.stopLoad();
            if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && retriesRemuxAsTranscode(playback)) {
              setForceTranscode(true);
              return;
            }
            setError(
              data.response?.code === 503 || data.response?.code === 429
                ? "videoPlayback.busy"
                : "videoPlayback.playFailed",
            );
          });
          instance.loadSource(sourceURL);
          instance.attachMedia(video);
          return;
        }
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = sourceURL;
          video.load();
          return;
        }
        setError("videoPlayback.hlsUnsupported");
      })
      .catch(() => {
        if (active) setError("videoPlayback.playerLoadFailed");
      });

    return () => {
      active = false;
      instance?.destroy();
      clearSource();
    };
  }, [playback, rememberPlayback]);

  // A new track reloads the source like a failure recovery, at the same position and play state.
  const changeAudioTrack = (streamIndex: number) => {
    if (streamIndex === (playback?.audioStream ?? audioStream)) return;
    rememberPlayback();
    changingSourceRef.current = true;
    videoRef.current?.pause();
    chooseVideoAudioStream(principalID, locationId, streamIndex);
    setError("");
    setAudioStream(streamIndex);
  };

  const startOver = () => {
    setResumedFrom(null);
    const video = videoRef.current;
    if (recoveryRef.current) recoveryRef.current.position = 0;
    else if (video && video.readyState > 0) video.currentTime = 0;
    positionRef.current.current = 0;
    writeResumePosition(0);
  };

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

  const handleStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    // Buttons beside the video keep Space and Enter.
    if (!video || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.target !== event.currentTarget && event.target !== video) return;
    const shortcut = videoShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    switch (shortcut.action) {
      case "togglePlay":
        if (event.repeat) return;
        toggleVideoPlayback(video);
        return;
      case "seek":
        seekVideoBy(video, shortcut.seconds, displayedDuration);
        return;
      case "fullscreen":
        toggleFullscreen();
        return;
      case "mute":
        video.muted = !video.muted;
        return;
      case "rate":
        changeRate(nextVideoPlaybackRate(video.playbackRate, shortcut.step));
        return;
    }
  };

  return (
    <div
      ref={stageRef}
      className={cn(
        "relative w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        fullscreen && "flex h-full flex-col bg-black",
      )}
      role="group"
      aria-label={t("videoPlayback.player")}
      aria-keyshortcuts="Space K J L ArrowLeft ArrowRight F M Shift+< Shift+>"
      tabIndex={-1}
      onKeyDown={handleStageKeyDown}
    >
      <div className={cn("@container/video relative", fullscreen && "min-h-0 flex-1")}>
        <video
          ref={videoRef}
          playsInline
          preload="metadata"
          className={cn("block w-full bg-black object-contain", fullscreen ? "h-full" : "max-h-[72vh]")}
          aria-label={
            displayedDuration > 0
              ? t("videoPlayback.previewDuration", { duration: formatVideoDuration(displayedDuration) })
              : t("videoPlayback.preview")
          }
          onPlay={() => {
            wantsPlaybackRef.current = true;
            if (recoveryRef.current) recoveryRef.current.playing = true;
            onPlay();
          }}
          onPause={(event) => {
            if (changingSourceRef.current || event.currentTarget.error) return;
            wantsPlaybackRef.current = false;
            if (recoveryRef.current) recoveryRef.current.playing = false;
            notePosition(event.currentTarget, true);
          }}
          onEnded={(event) => {
            wantsPlaybackRef.current = false;
            setResumedFrom(null);
            notePosition(event.currentTarget, true);
          }}
          onTimeUpdate={(event) => notePosition(event.currentTarget)}
          onSeeked={(event) => notePosition(event.currentTarget, true)}
          onLoadedMetadata={(event) => {
            changingSourceRef.current = false;
            const recovery = recoveryRef.current;
            if (!recovery) return;
            const video = event.currentTarget;
            // hls.js may already have started at an earlier recovery position.
            if (recovery.position > 0 || video.currentTime > 0) {
              const end = Number.isFinite(video.duration) ? video.duration : recovery.position;
              try {
                video.currentTime = Math.min(recovery.position, end);
              } catch {
                setError("videoPlayback.restoreFailed");
                return;
              }
            }
            recoveryRef.current = null;
            if (recovery.playing) {
              const generation = sourceGenerationRef.current;
              void video.play().catch((reason: unknown) => {
                if (generation !== sourceGenerationRef.current) return;
                if (
                  reason instanceof DOMException &&
                  (reason.name === "NotAllowedError" || reason.name === "AbortError")
                ) {
                  return;
                }
                rememberPlayback();
                setError("videoPlayback.playFailed");
              });
            }
          }}
          onPlaying={() => setError("")}
          onError={() => {
            if (!playback) return;
            if (playback.delivery === "hls" && hlsManagedRef.current) return;
            rememberPlayback();
            if (
              ((playback.delivery === "direct" && canTranscode) || retriesRemuxAsTranscode(playback)) &&
              !forceTranscode
            ) {
              setForceTranscode(true);
              return;
            }
            setError("videoPlayback.playFailed");
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
        {rateNotice !== null && (
          <div
            className="pointer-events-none absolute right-3 top-3 rounded-md bg-background/80 px-2.5 py-1 text-sm tabular-nums text-foreground backdrop-blur"
            role="status"
          >
            {t("videoPlayback.playbackRate", { rate: rateNotice })}
          </div>
        )}
      </div>
      {!playback && !error && (
        <div className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("videoPlayback.preparing")}
        </div>
      )}
      {audioTracks.length > 0 && (
        <div className="mt-3 flex min-h-11 items-center gap-3 px-3 text-sm text-muted-foreground sm:px-0">
          <label htmlFor={`video-audio-track-${locationId}`}>{t("videoPlayback.audioTrack")}</label>
          <NativeSelect
            id={`video-audio-track-${locationId}`}
            className="w-auto min-w-0 max-w-full flex-1 sm:flex-none"
            value={playback?.audioStream ?? audioStream ?? ""}
            disabled={!playback}
            onChange={(event) => changeAudioTrack(Number(event.target.value))}
          >
            {audioTracks.map((track, position) => (
              <option key={track.streamIndex} value={track.streamIndex}>
                {videoAudioTrackLabel(track, position, t, i18n.language)}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {resumedFrom !== null && !error && (
        <div
          role="status"
          className="mt-3 flex min-h-11 items-center justify-between gap-3 px-3 text-sm text-muted-foreground sm:px-0"
        >
          <span>{t("videoPlayback.resumedAt", { time: formatVideoDuration(resumedFrom) })}</span>
          <Button variant="outline" size="sm" onClick={startOver}>
            <RotateCcw className="h-4 w-4" />
            {t("videoPlayback.startOver")}
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          <span>{t(error)}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              rememberPlayback();
              setError("");
              setRetryToken((value) => value + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t("videoPlayback.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

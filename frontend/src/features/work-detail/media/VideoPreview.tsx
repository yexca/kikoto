import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, assetURL, type VideoPlaybackInfo } from "@/lib/api";
import { playbackURL, prefersNativeVideoHls, videoPlaybackCapabilities } from "@/player/mediaPlayback";
import {
  CONSERVATIVE_HLS_CONFIG,
  prepareVideoPlayback,
  videoPlaybackFailureKey,
} from "@/features/work-detail/media/videoPlaybackModel";
import {
  readVideoResumePosition,
  videoResumeStorageKey,
  writeVideoResumePosition,
} from "@/features/work-detail/media/videoResume";
import { nextVideoPlaybackRate, videoShortcut } from "@/features/work-detail/media/videoShortcuts";
import { type VideoSubtitle, videoSubtitleWebVtt } from "@/features/work-detail/media/videoSubtitles";

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
const MAX_SUBTITLE_BYTES = 512 * 1024;
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
  const { t } = useTranslation();
  const auth = useAuth();
  const resumeStorageKey = videoResumeStorageKey(auth.user?.id ?? null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackInfo | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [error, setError] = useState("");
  const [resumedFrom, setResumedFrom] = useState(() => {
    const storage = browserStorage();
    return storage ? readVideoResumePosition(storage, resumeStorageKey, locationId) : null;
  });
  const [rateNotice, setRateNotice] = useState<number | null>(null);
  const subtitleTracks = useSubtitleTracks(subtitles);
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
        api.getVideoPlaybackInfo(locationId, await videoPlaybackCapabilities(), forceTranscode, controller.signal),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPlayback(value);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(videoPlaybackFailureKey(reason));
      });
    return () => controller.abort();
  }, [canTranscode, durationSeconds, fallbackUrl, forceTranscode, locationId, retryToken]);

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

  // Sidecar subtitles show from the start; the listener can turn them off in the video controls.
  useEffect(() => {
    const video = videoRef.current;
    const first = video?.querySelector("track")?.track;
    if (!video || !first || Array.from(video.textTracks).some((track) => track.mode === "showing")) return;
    first.mode = "showing";
  }, [subtitleTracks]);

  const startOver = () => {
    setResumedFrom(null);
    const video = videoRef.current;
    if (recoveryRef.current) recoveryRef.current.position = 0;
    else if (video && video.readyState > 0) video.currentTime = 0;
    positionRef.current.current = 0;
    writeResumePosition(0);
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
        if (video.paused || video.ended) void video.play().catch(() => undefined);
        else video.pause();
        return;
      case "seek": {
        if (video.readyState === 0) return;
        const end = Number.isFinite(video.duration) ? video.duration : displayedDuration || Number.POSITIVE_INFINITY;
        video.currentTime = Math.min(Math.max(0, video.currentTime + shortcut.seconds), end);
        return;
      }
      case "fullscreen":
        toggleVideoFullscreen(video);
        return;
      case "mute":
        video.muted = !video.muted;
        return;
      case "rate":
        video.playbackRate = nextVideoPlaybackRate(video.playbackRate, shortcut.step);
        setRateNotice(video.playbackRate);
        return;
    }
  };

  return (
    <div
      className="relative w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="group"
      aria-label={t("videoPlayback.player")}
      aria-keyshortcuts="Space K J L ArrowLeft ArrowRight F M Shift+< Shift+>"
      tabIndex={-1}
      onKeyDown={handleStageKeyDown}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        className="max-h-[72vh] w-full bg-black object-contain"
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
          if (playback.delivery === "direct" && canTranscode && !forceTranscode) {
            setForceTranscode(true);
            return;
          }
          setError("videoPlayback.playFailed");
        }}
      >
        {subtitleTracks.map((track) => (
          <track key={track.key} kind="subtitles" src={track.src} label={track.label} />
        ))}
      </video>
      {rateNotice !== null && (
        <div
          className="pointer-events-none absolute right-3 top-3 rounded-md bg-background/80 px-2.5 py-1 text-sm tabular-nums text-foreground backdrop-blur"
          role="status"
        >
          {t("videoPlayback.playbackRate", { rate: rateNotice })}
        </div>
      )}
      {!playback && !error && (
        <div className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("videoPlayback.preparing")}
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

type SubtitleTrack = { key: string; label: string; src: string };

/** Loads sidecar subtitle files as WebVTT object URLs for `<track>` elements; a file that fails is left out. */
function useSubtitleTracks(subtitles: VideoSubtitle[]) {
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  useEffect(() => {
    if (subtitles.length === 0) return;
    const controller = new AbortController();
    const urls: string[] = [];
    void Promise.allSettled(subtitles.map((subtitle) => loadSubtitleText(subtitle, controller.signal))).then(
      (results) => {
        if (controller.signal.aborted) return;
        const loaded: SubtitleTrack[] = [];
        results.forEach((result, index) => {
          const content = result.status === "fulfilled" ? videoSubtitleWebVtt(result.value) : null;
          if (!content) return;
          const src = URL.createObjectURL(new Blob([content], { type: "text/vtt" }));
          urls.push(src);
          const subtitle = subtitles[index];
          loaded.push({ key: `${subtitle.locationId}:${subtitle.url ?? ""}`, label: subtitle.title, src });
        });
        setTracks(loaded);
      },
    );
    return () => {
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      setTracks([]);
    };
  }, [subtitles]);
  return tracks;
}

async function loadSubtitleText(subtitle: VideoSubtitle, signal: AbortSignal) {
  if (!subtitle.url) return (await api.getMediaText(subtitle.locationId)).content;
  const response = await fetch(assetURL(subtitle.url), { headers: { Accept: "text/plain,text/*" }, signal });
  if (!response.ok) throw new Error(`Subtitle request returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_SUBTITLE_BYTES) throw new Error("Subtitle too large.");
  const content = await response.text();
  if (content.length > MAX_SUBTITLE_BYTES) throw new Error("Subtitle too large.");
  return content;
}

function toggleVideoFullscreen(video: HTMLVideoElement) {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  if (typeof video.requestFullscreen === "function") {
    void video.requestFullscreen().catch(() => undefined);
    return;
  }
  // iOS Safari offers fullscreen only on the video element itself.
  (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }).webkitEnterFullscreen?.();
}

function formatVideoDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

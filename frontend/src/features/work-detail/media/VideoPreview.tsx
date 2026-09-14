import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import { Button } from "@/components/ui/button";
import { api, assetURL, type VideoPlaybackInfo } from "@/lib/api";
import { playbackCapabilities, playbackURL } from "@/player/mediaPlayback";
import {
  CONSERVATIVE_HLS_CONFIG,
  prepareVideoPlayback,
  videoPlaybackFailureKey,
} from "@/features/work-detail/media/videoPlaybackModel";

type VideoPreviewProps = {
  locationId: number;
  fallbackUrl: string;
  durationSeconds: number | null;
  canTranscode: boolean;
  pauseRequested: boolean;
  onPlay: () => void;
};

export function VideoPreview(props: VideoPreviewProps) {
  return <VideoPlayback key={`${props.locationId}:${props.fallbackUrl}`} {...props} />;
}

function VideoPlayback({
  locationId,
  fallbackUrl,
  durationSeconds,
  canTranscode,
  pauseRequested,
  onPlay,
}: VideoPreviewProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackInfo | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [error, setError] = useState("");
  const wantsPlaybackRef = useRef(false);
  const changingSourceRef = useRef(false);
  const hlsManagedRef = useRef(false);
  const sourceGenerationRef = useRef(0);
  const recoveryRef = useRef<{ position: number; playing: boolean } | null>(null);

  const rememberPlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || recoveryRef.current) return;
    recoveryRef.current = {
      position: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      playing: wantsPlaybackRef.current,
    };
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
      () => api.getVideoPlaybackInfo(locationId, playbackCapabilities("video"), forceTranscode, controller.signal),
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
    if (playback.delivery === "direct") {
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

  const displayedDuration = playback?.durationSeconds || durationSeconds || 0;
  return (
    <div className="w-full">
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
        }}
        onEnded={() => {
          wantsPlaybackRef.current = false;
        }}
        onLoadedMetadata={(event) => {
          changingSourceRef.current = false;
          const recovery = recoveryRef.current;
          if (!recovery) return;
          const video = event.currentTarget;
          if (recovery.position > 0) {
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
      />
      {!playback && !error && (
        <div className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("videoPlayback.preparing")}
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

function formatVideoDuration(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

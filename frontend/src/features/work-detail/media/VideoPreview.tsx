import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import { Button } from "@/components/ui/button";
import { api, assetURL, type VideoPlaybackInfo } from "@/lib/api";
import { playbackCapabilities, playbackURL } from "@/player/mediaPlayback";
import { CONSERVATIVE_HLS_CONFIG } from "@/features/work-detail/media/videoPlaybackModel";

type VideoPreviewProps = {
  locationId: number;
  fallbackUrl: string;
  durationSeconds: number | null;
  canTranscode: boolean;
  pauseRequested: boolean;
  onPlay: () => void;
};

export function VideoPreview({
  locationId,
  fallbackUrl,
  durationSeconds,
  canTranscode,
  pauseRequested,
  onPlay,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackInfo | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    setPlayback(null);
    setForceTranscode(false);
    setError("");
  }, [fallbackUrl, locationId]);

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
    void api
      .getVideoPlaybackInfo(locationId, playbackCapabilities("video"), forceTranscode, controller.signal)
      .then(setPlayback)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "This video could not be prepared.");
      });
    return () => controller.abort();
  }, [canTranscode, durationSeconds, fallbackUrl, forceTranscode, locationId, retryToken]);

  useEffect(() => {
    if (pauseRequested) videoRef.current?.pause();
  }, [pauseRequested]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback?.url) return;
    let active = true;
    let instance: Hls | null = null;
    const sourceURL = assetURL(playback.url);

    const clearSource = () => {
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
          instance = new HlsConstructor(CONSERVATIVE_HLS_CONFIG);
          instance.on(HlsConstructor.Events.ERROR, (_event: string, data: ErrorData) => {
            if (!data.fatal || !instance || !active) return;
            if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 1) {
              mediaRecoveryAttempts++;
              instance.recoverMediaError();
              return;
            }
            setError("This video could not be played.");
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
        setError("HLS playback is not supported on this device.");
      })
      .catch(() => {
        if (active) setError("The video player could not be loaded.");
      });

    return () => {
      active = false;
      instance?.destroy();
      clearSource();
    };
  }, [playback]);

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
          displayedDuration > 0 ? `Video preview, duration ${formatVideoDuration(displayedDuration)}` : "Video preview"
        }
        onPlay={onPlay}
        onLoadedMetadata={() => setError("")}
        onError={() => {
          if (!playback) return;
          if (playback.delivery === "direct" && canTranscode && !forceTranscode) {
            setForceTranscode(true);
            return;
          }
          if (playback.delivery === "direct") setError("This video could not be played.");
        }}
      />
      {!playback && !error && (
        <div className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing video
        </div>
      )}
      {error && (
        <div className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setRetryToken((value) => value + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" />
            Retry
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

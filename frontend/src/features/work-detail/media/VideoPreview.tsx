import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type VideoAudioTrack, type VideoPlaybackInfo } from "@/lib/api";
import { playbackURL, videoPlaybackCapabilities } from "@/player/mediaPlayback";
import { formatVideoDuration } from "@/player/video/videoControlsModel";
import {
  VideoStage,
  type VideoStageFailure,
  type VideoStageHandle,
  type VideoStagePosition,
} from "@/player/video/VideoStage";
import type { VideoSubtitle } from "@/player/video/videoSubtitles";
import { prepareVideoPlayback, videoPlaybackFailureKey } from "@/player/videoPlaybackModel";
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
// While playing, the stored resume position follows the video in steps of this many seconds.
const resumeWriteIntervalSeconds = 5;

const failureMessages: Record<Exclude<VideoStageFailure, "direct" | "transcode">, string> = {
  busy: "videoPlayback.busy",
  playFailed: "videoPlayback.playFailed",
  hlsUnsupported: "videoPlayback.hlsUnsupported",
  playerLoadFailed: "videoPlayback.playerLoadFailed",
  restoreFailed: "videoPlayback.restoreFailed",
};

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

/**
 * A work video in the file preview: the shared video stage with this
 * browser's resume position, the choice of audio track, and the preparation
 * and failure states below it.
 */
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
  const principalID = useAuth().user?.id ?? null;
  const resumeStorageKey = videoResumeStorageKey(principalID);
  const stage = useRef<VideoStageHandle | null>(null);
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
  // The first source starts at the stored resume position, paused.
  const [start] = useState(() => (resumedFrom === null ? null : { position: resumedFrom, playing: false }));
  const writtenRef = useRef<number | null>(resumedFrom);

  const displayedDuration = playback?.durationSeconds || durationSeconds || 0;

  const writeResumePosition = useStableCallback((position: number, duration?: number) => {
    const storage = browserStorage();
    if (!storage) return;
    writeVideoResumePosition(storage, resumeStorageKey, locationId, position, duration ?? displayedDuration);
    writtenRef.current = position;
  });

  // The position follows the video every few seconds while it plays, and at once on any other report.
  const notePosition = ({ position, duration, moment }: VideoStagePosition) => {
    if (moment === "ended") setResumedFrom(null);
    const written = writtenRef.current;
    if (moment === "time" && written !== null && Math.abs(position - written) < resumeWriteIntervalSeconds) return;
    writeResumePosition(position, duration);
  };

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
    if (pauseRequested) stage.current?.pause();
  }, [pauseRequested]);

  // A file the browser cannot play, or a remux it cannot decode, is prepared again as a conversion.
  const fail = (failure: VideoStageFailure) => {
    const convertible = failure === "transcode" || (failure === "direct" && canTranscode);
    if (convertible && !forceTranscode) {
      setForceTranscode(true);
      return;
    }
    setError(failure === "direct" || failure === "transcode" ? "videoPlayback.playFailed" : failureMessages[failure]);
  };

  // A new track reloads the source like a failure recovery, at the same position and play state.
  const changeAudioTrack = (streamIndex: number) => {
    if (streamIndex === (playback?.audioStream ?? audioStream)) return;
    stage.current?.holdForNewSource();
    chooseVideoAudioStream(principalID, locationId, streamIndex);
    setError("");
    setAudioStream(streamIndex);
  };

  const startOver = () => {
    setResumedFrom(null);
    stage.current?.seekTo(0);
    writeResumePosition(0);
  };

  return (
    <VideoStage
      ref={stage}
      playback={playback}
      start={start}
      subtitles={subtitles}
      fallbackDuration={durationSeconds ?? 0}
      layout="inline"
      onFailure={fail}
      onPlay={onPlay}
      onPlaying={() => setError("")}
      onPosition={notePosition}
    >
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
              stage.current?.holdForNewSource();
              setError("");
              setRetryToken((value) => value + 1);
            }}
          >
            <RefreshCw className="h-4 w-4" />
            {t("videoPlayback.retry")}
          </Button>
        </div>
      )}
    </VideoStage>
  );
}

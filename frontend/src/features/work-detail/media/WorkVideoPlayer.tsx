import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth/AuthProvider";
import { MediaOverlay } from "@/components/media-overlay";
import { NativeSelect } from "@/components/ui/input";
import { useMobileNavigationLayout } from "@/hooks/useMobileNavigationLayout";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type VideoAudioTrack, type VideoPlaybackInfo } from "@/lib/api";
import { localStore } from "@/lib/clientStorage";
import { startLoad } from "@/lib/effectScope";
import { playbackURL, videoPlaybackCapabilities } from "@/player/mediaPlayback";
import { usePlayer } from "@/player/PlayerProvider";
import { VideoPlayerHeader } from "@/player/video/VideoPlayerHeader";
import { VideoPlayerStatus } from "@/player/video/VideoPlayerStatus";
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

/** A work video the file viewer plays. */
export type WorkVideo = {
  locationId: number;
  title: string;
  /** The file itself, played as it is when the server cannot convert it. */
  url: string;
  durationSeconds: number | null;
  canTranscode: boolean;
  /** Same-name subtitle files beside the video. */
  subtitles?: VideoSubtitle[];
};

type Phase = { kind: "prompt"; position: number } | { kind: "playing"; startAt: number };

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

/**
 * The full-screen player for a work's videos, laid out like the Record player:
 * the shared video stage under a header with the video's place among the
 * folder's videos, previous and next, and the audio track choice. It asks
 * whether to continue from the position this browser stored, plays what the
 * server's playback info chooses, and prepares a file the browser cannot play
 * again as a conversion. On a phone a video enters fullscreen when it starts.
 * Remount it per video (`key`) so each starts with its own position.
 */
export function WorkVideoPlayer({
  video,
  index,
  total,
  onPrevious,
  onNext,
  onClose,
}: {
  video: WorkVideo;
  index: number;
  total: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { locationId, title, url: fallbackUrl, durationSeconds, canTranscode } = video;
  const subtitles = video.subtitles ?? noSubtitles;
  const principalID = useAuth().user?.id ?? null;
  const resumeStorageKey = videoResumeStorageKey(principalID);
  const phone = useMobileNavigationLayout();
  const player = usePlayer();
  const stage = useRef<VideoStageHandle | null>(null);
  const [playback, setPlayback] = useState<VideoPlaybackInfo | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // The audio track chosen in this page session; null plays the default track.
  const [audioStream, setAudioStream] = useState(() => chosenVideoAudioStream(principalID, locationId));
  const [audioTracks, setAudioTracks] = useState<VideoAudioTrack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stored] = useState(() => readVideoResumePosition(localStore, resumeStorageKey, locationId));
  const [phase, setPhase] = useState<Phase>(() =>
    stored === null ? { kind: "playing", startAt: 0 } : { kind: "prompt", position: stored },
  );
  const writtenRef = useRef<number | null>(stored);

  const displayedDuration = playback?.durationSeconds || durationSeconds || 0;

  const writeResumePosition = useStableCallback((position: number, duration?: number) => {
    writeVideoResumePosition(localStore, resumeStorageKey, locationId, position, duration ?? displayedDuration);
    writtenRef.current = position;
  });

  // The position follows the video every few seconds while it plays, and at once on any other report.
  const notePosition = ({ position, duration, moment }: VideoStagePosition) => {
    const written = writtenRef.current;
    if (moment === "time" && written !== null && Math.abs(position - written) < resumeWriteIntervalSeconds) return;
    writeResumePosition(position, duration);
  };

  // Ask how the video plays while the start position is being chosen.
  useEffect(() => {
    if (!canTranscode || locationId <= 0) {
      setPlayback({
        delivery: "direct",
        url: playbackURL(fallbackUrl, "video"),
        durationSeconds: durationSeconds ?? 0,
        seekable: true,
      });
      return;
    }
    setPlayback(null);
    return startLoad(
      (signal) =>
        prepareVideoPlayback(
          async () =>
            api.getVideoPlaybackInfo(
              locationId,
              await videoPlaybackCapabilities(),
              forceTranscode,
              signal,
              audioStream,
            ),
          signal,
        ),
      {
        onSuccess: (value) => {
          setAudioTracks(videoAudioTrackChoices(value));
          setPlayback(value);
        },
        onError: (reason) => {
          if (audioStream !== null && rejectsVideoAudioStream(reason)) {
            forgetChosenVideoAudioStream(principalID, locationId);
            setAudioStream(null);
            return;
          }
          setError(videoPlaybackFailureKey(reason));
        },
      },
    );
  }, [audioStream, canTranscode, durationSeconds, fallbackUrl, forceTranscode, locationId, principalID, retryToken]);

  // The video takes over from the global audio player, and pauses when that player starts again.
  useEffect(() => {
    if (player.isPlaying) stage.current?.pause();
  }, [player.isPlaying]);

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
    setError(null);
    setAudioStream(streamIndex);
  };

  const playing = phase.kind === "playing";
  const startAt = playing ? phase.startAt : null;
  const source = playing && !error ? playback : null;
  const controls = source !== null;
  // The stage's shortcuts work while focus is on the player rather than on a button.
  const handleKeyDown = controls
    ? (event: ReactKeyboardEvent<HTMLDivElement>) => stage.current?.handleKeyDown(event)
    : undefined;

  return (
    <MediaOverlay label={t("videoPlayback.playerLabel", { name: title })} onClose={onClose} onKeyDown={handleKeyDown}>
      <VideoPlayerHeader
        title={title}
        index={index}
        total={total}
        shortcuts={!phone}
        previous={{ label: t("videoPlayback.previousVideo"), onStep: onPrevious }}
        next={{ label: t("videoPlayback.nextVideo"), onStep: onNext }}
        onClose={onClose}
      >
        {audioTracks.length > 0 && (
          <NativeSelect
            aria-label={t("videoPlayback.audioTrack")}
            title={t("videoPlayback.audioTrack")}
            className="w-auto min-w-0 max-w-28 sm:max-w-48"
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
        )}
      </VideoPlayerHeader>
      {/* The stage fits both the width and the height, so the controls stay on screen. */}
      <VideoStage
        ref={stage}
        playback={source}
        start={startAt === null ? null : { position: startAt, playing: true }}
        subtitles={subtitles}
        fallbackDuration={durationSeconds ?? 0}
        controls={controls}
        enterFullscreen={phone && playing}
        onFailure={fail}
        onPlay={player.pause}
        onPosition={notePosition}
      >
        <VideoPlayerStatus
          error={error ? t(error) : null}
          loading={!error && playing && playback === null}
          resumePosition={phase.kind === "prompt" ? phase.position : null}
          onRetry={() => {
            stage.current?.holdForNewSource();
            setError(null);
            setRetryToken((value) => value + 1);
          }}
          onResume={() => phase.kind === "prompt" && setPhase({ kind: "playing", startAt: phase.position })}
          onStartOver={() => {
            setPhase({ kind: "playing", startAt: 0 });
            writeResumePosition(0);
          }}
        />
      </VideoStage>
    </MediaOverlay>
  );
}

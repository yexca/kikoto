import { Headphones, Trash2 } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MediaOverlay } from "@/components/media-overlay";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type RecordAsset, type RecordProgress, type VideoPlaybackInfo } from "@/lib/api";
import { videoPlaybackCapabilities } from "@/player/mediaPlayback";
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
import { prepareVideoPlayback } from "@/player/videoPlaybackModel";

import { RecordProgressTracker, resumePosition } from "./recordProgress";
import { baseName } from "./recordsModel";

type Phase = { kind: "checking" } | { kind: "prompt"; position: number } | { kind: "playing"; startAt: number };

type Source = { forceTranscode: boolean; playback: VideoPlaybackInfo | null };

/**
 * The full-screen Record video player. It asks whether to continue from a
 * saved position, plays what the server's playback info chooses (the file
 * itself, a remux, or a transcode) on the shared video stage, saves progress
 * while the video plays, and steps through the folder's videos. On a phone a
 * video enters fullscreen when it starts. The row under the video plays its
 * sound as audio, which hands it to the global player from the moment it
 * reached, and keeps Delete behind More. Remount it per video (`key`)
 * so each starts with its own progress.
 */
export function RecordMediaPlayer({
  asset,
  subtitle,
  index,
  total,
  previousId,
  nextId,
  knownProgress,
  autoResume,
  canSaveProgress,
  phone,
  onStep,
  onListen,
  onDelete,
  onClose,
  onProgressSaved,
}: {
  asset: RecordAsset;
  subtitle?: RecordAsset;
  index: number;
  total: number;
  previousId: number | null;
  nextId: number | null;
  /** Progress the folder already read for this video, if any. */
  knownProgress?: RecordProgress;
  /** Continue from the saved position without asking, as the Continue watching list does. */
  autoResume: boolean;
  canSaveProgress: boolean;
  /** A phone layout, where a video enters fullscreen when it starts. */
  phone: boolean;
  onStep: (id: number) => void;
  /** Plays the video's sound in the global player from `position`; the player closes. */
  onListen: (position: number) => void;
  /** Reviews deleting the video, which pauses; absent for a viewer who may not delete files. */
  onDelete?: () => void;
  onClose: () => void;
  onProgressSaved: (id: number, progress: RecordProgress) => void;
}) {
  const { t } = useTranslation();
  const stage = useRef<VideoStageHandle | null>(null);
  const tracker = useRef<RecordProgressTracker | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [error, setError] = useState<{ busy: boolean } | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [source, setSource] = useState<Source>({ forceTranscode: false, playback: null });
  const title = baseName(asset.name);
  const prepared = source.forceTranscode === forceTranscode ? source.playback : null;
  // A failed source is detached until Retry prepares it again.
  const playback = error ? null : prepared;

  // Decide where playback starts: the saved position, after asking unless the
  // Continue watching list opened the player, or the beginning.
  const [initialProgress] = useState(knownProgress);
  const decide = useStableCallback((progress: RecordProgress | undefined) => {
    const position = resumePosition(progress);
    if (position === null) setPhase({ kind: "playing", startAt: 0 });
    else if (autoResume) setPhase({ kind: "playing", startAt: position });
    else setPhase({ kind: "prompt", position });
  });
  useEffect(() => {
    const controller = new AbortController();
    if (initialProgress) decide(initialProgress);
    else
      void api
        .getRecordProgress(asset.id, controller.signal)
        .then((progress) => {
          if (!controller.signal.aborted) decide(progress);
        })
        .catch(() => {
          if (!controller.signal.aborted) decide(undefined);
        });
    return () => controller.abort();
  }, [decide, initialProgress, asset.id]);

  // Ask how the video plays while the start position is being chosen.
  useEffect(() => {
    const controller = new AbortController();
    void prepareVideoPlayback(
      async () =>
        api.getRecordPlayback(
          asset.id,
          { capabilities: await videoPlaybackCapabilities(), forceTranscode },
          controller.signal,
        ),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setSource({ forceTranscode, playback: value });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = reason && typeof reason === "object" && "status" in reason ? reason.status : null;
        setError({ busy: status === 503 || status === 429 });
      });
    return () => controller.abort();
  }, [asset.id, forceTranscode, retryToken]);

  // A video takes over from the global audio player when it starts, and
  // pauses when that player starts again; the audio stays paused after the
  // player closes.
  const player = usePlayer();
  const pauseAudio = useStableCallback(() => {
    if (player.isPlaying) player.pause();
  });
  useEffect(() => {
    if (player.isPlaying) stage.current?.pause();
  }, [player.isPlaying]);
  const save = useStableCallback((progress: RecordProgress) => {
    if (!canSaveProgress) return;
    void api
      .updateRecordProgress(asset.id, progress)
      .then(() => onProgressSaved(asset.id, progress))
      .catch(() => {
        // Progress is best effort; playback continues without it.
      });
  });

  // Progress saves from where playback starts.
  const startAt = phase.kind === "playing" ? phase.startAt : null;
  useEffect(() => {
    if (startAt !== null) tracker.current = new RecordProgressTracker(save, startAt);
  }, [save, startAt]);

  // A file the browser cannot play, or a remux it cannot decode, is prepared again as a conversion.
  const failVideo = (failure: VideoStageFailure) => {
    if ((failure === "transcode" || failure === "direct") && !forceTranscode) {
      setForceTranscode(true);
      return;
    }
    setError({ busy: failure === "busy" });
  };
  const trackVideo = ({ position, duration, moment }: VideoStagePosition) => {
    const current = tracker.current;
    if (!current) return;
    if (moment === "time") current.timeUpdate(position, duration);
    else if (moment === "pause") current.pause(position, duration);
    else if (moment === "ended") current.ended(duration);
    else if (moment === "leave") current.close(position, duration);
  };

  const sidecars = useMemo<VideoSubtitle[]>(
    () =>
      subtitle?.streamUrl ? [{ locationId: subtitle.id, title: baseName(subtitle.name), url: subtitle.streamUrl }] : [],
    [subtitle],
  );

  // Listening continues from the moment the video reached, or from where it would start.
  const listen = () => {
    const position = stage.current?.currentTime();
    const fallback = phase.kind === "prompt" ? phase.position : (startAt ?? 0);
    onListen(position !== undefined && Number.isFinite(position) && position > 0 ? position : fallback);
  };

  const playing = phase.kind === "playing";
  const controls = playing && playback !== null;
  const loading = !error && (phase.kind === "checking" || (playing && playback === null));
  // The stage's shortcuts work while focus is on the player rather than on a button.
  const handleKeyDown = controls
    ? (event: ReactKeyboardEvent<HTMLDivElement>) => stage.current?.handleKeyDown(event)
    : undefined;

  const retry = () => {
    setError(null);
    setSource({ forceTranscode, playback: null });
    setRetryToken((value) => value + 1);
  };

  return (
    <MediaOverlay label={t("videoPlayback.playerLabel", { name: title })} onClose={onClose} onKeyDown={handleKeyDown}>
      <VideoPlayerHeader
        title={title}
        index={index}
        total={total}
        shortcuts={!phone}
        previous={{
          label: t("videoPlayback.previousVideo"),
          onStep: previousId === null ? null : () => onStep(previousId),
        }}
        next={{
          label: t("videoPlayback.nextVideo"),
          onStep: nextId === null ? null : () => onStep(nextId),
        }}
        onClose={onClose}
      />
      {/* The stage fits both the width and the height, so the controls stay on screen. */}
      <VideoStage
        ref={stage}
        playback={playing ? playback : null}
        start={startAt === null ? null : { position: startAt, playing: true }}
        subtitles={sidecars}
        fallbackDuration={asset.durationSeconds ?? 0}
        poster={asset.thumbnailUrl}
        controls={controls}
        enterFullscreen={phone && playing}
        onFailure={failVideo}
        onPlay={pauseAudio}
        onPosition={trackVideo}
      >
        <VideoPlayerStatus
          error={error ? t(error.busy ? "records.player.busy" : "records.player.unavailable") : null}
          loading={loading}
          resumePosition={phase.kind === "prompt" ? phase.position : null}
          onRetry={retry}
          onResume={() => phase.kind === "prompt" && setPhase({ kind: "playing", startAt: phase.position })}
          onStartOver={() => setPhase({ kind: "playing", startAt: 0 })}
        />
      </VideoStage>
      {/* The video's actions sit under it; deletion waits behind More, then a two-step review. */}
      <div className="flex shrink-0 items-center gap-2 px-2 py-2 sm:px-4">
        <Button variant="secondary" size="sm" onClick={listen}>
          <Headphones className="h-4 w-4" />
          {t("records.player.listen")}
        </Button>
        {onDelete && (
          <ActionMenu
            quiet
            label={t("records.actions.more")}
            buttonLabel={t("records.actions.more")}
            buttonLabelClassName="hidden"
            triggerClassName="h-[var(--control-height-sm)] w-[var(--control-height-sm)]"
            align="start"
            items={[
              {
                key: "delete",
                label: t("records.delete.action"),
                icon: <Trash2 className="h-4 w-4" />,
                onSelect: () => {
                  stage.current?.pause();
                  onDelete();
                },
              },
            ]}
          />
        )}
      </div>
    </MediaOverlay>
  );
}

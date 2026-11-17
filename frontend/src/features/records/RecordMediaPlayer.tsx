import { ChevronLeft, ChevronRight, Headphones, Loader2, Music, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, assetURL, type RecordAsset, type RecordProgress, type VideoPlaybackInfo } from "@/lib/api";
import { attachPlaybackSource, type PlaybackSourceFailure } from "@/player/attachPlaybackSource";
import { playbackCapabilities, videoPlaybackCapabilities } from "@/player/mediaPlayback";
import { usePlayer } from "@/player/PlayerProvider";
import {
  VideoStage,
  type VideoStageFailure,
  type VideoStageHandle,
  type VideoStagePosition,
} from "@/player/video/VideoStage";
import type { VideoSubtitle } from "@/player/video/videoSubtitles";
import { prepareVideoPlayback } from "@/player/videoPlaybackModel";

import { RecordOverlay } from "./RecordOverlay";
import { RecordProgressTracker, resumePosition } from "./recordProgress";
import { RecordShortcutsButton } from "./RecordShortcutsButton";
import { baseName, formatPlaybackTime } from "./recordsModel";

type Phase = { kind: "checking" } | { kind: "prompt"; position: number } | { kind: "playing"; startAt: number };

type Source = { listening: boolean; forceTranscode: boolean; playback: VideoPlaybackInfo | null };

/**
 * The full-screen Record player for videos and audio files. It asks whether to
 * continue from a saved position, plays what the server's playback info
 * chooses (the file itself, a remux, or a transcode), saves progress while the
 * media plays, and steps through the folder's items of the same kind. Videos
 * play on the shared video stage; on a phone a video enters fullscreen when it
 * starts. A video can play as audio only, which loads only its sound. Remount
 * it per item (`key`) so each starts with its own progress.
 */
export function RecordMediaPlayer({
  asset,
  subtitle,
  artworkUrl,
  index,
  total,
  previousId,
  nextId,
  knownProgress,
  autoResume,
  audioOnly,
  canSaveProgress,
  phone,
  onAudioOnlyChange,
  onStep,
  onClose,
  onProgressSaved,
}: {
  asset: RecordAsset;
  subtitle?: RecordAsset;
  /** A picture shown while listening: the folder's poster when the item has no thumbnail. */
  artworkUrl?: string;
  index: number;
  total: number;
  previousId: number | null;
  nextId: number | null;
  /** Progress the folder already read for this item, if any. */
  knownProgress?: RecordProgress;
  /** Continue from the saved position without asking, as the Continue watching list does. */
  autoResume: boolean;
  /** Play a video's sound alone; audio files always play this way. */
  audioOnly: boolean;
  canSaveProgress: boolean;
  /** A phone layout, where a video enters fullscreen when it starts. */
  phone: boolean;
  onAudioOnlyChange: (audioOnly: boolean) => void;
  onStep: (id: number) => void;
  onClose: () => void;
  onProgressSaved: (id: number, progress: RecordProgress) => void;
}) {
  const { t } = useTranslation();
  const isVideo = asset.kind === "video";
  const listening = !isVideo || audioOnly;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stage = useRef<VideoStageHandle | null>(null);
  const tracker = useRef<RecordProgressTracker | null>(null);
  // Where audio stood when it failed, so Retry continues from there; the video stage keeps its own.
  const failedAt = useRef(0);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [error, setError] = useState<{ busy: boolean } | null>(null);
  const [forceTranscode, setForceTranscode] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [source, setSource] = useState<Source>({ listening, forceTranscode: false, playback: null });
  const title = baseName(asset.name);
  const prepared = source.listening === listening && source.forceTranscode === forceTranscode ? source.playback : null;
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

  // Ask how the item plays while the start position is being chosen.
  useEffect(() => {
    const controller = new AbortController();
    void prepareVideoPlayback(
      async () =>
        api.getRecordPlayback(
          asset.id,
          {
            capabilities: listening ? playbackCapabilities("audio") : await videoPlaybackCapabilities(),
            profile: isVideo && listening ? "audio" : undefined,
            forceTranscode,
          },
          controller.signal,
        ),
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setSource({ listening, forceTranscode, playback: value });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const status = reason && typeof reason === "object" && "status" in reason ? reason.status : null;
        setError({ busy: status === 503 || status === 429 });
      });
    return () => controller.abort();
  }, [asset.id, forceTranscode, isVideo, listening, retryToken]);

  // A record item takes over from the global audio player when it starts;
  // the audio stays paused after the player closes.
  const player = usePlayer();
  const pauseAudio = useStableCallback(() => {
    if (player.isPlaying) player.pause();
  });
  const save = useStableCallback((progress: RecordProgress) => {
    if (!canSaveProgress) return;
    void api
      .updateRecordProgress(asset.id, progress)
      .then(() => onProgressSaved(asset.id, progress))
      .catch(() => {
        // Progress is best effort; playback continues without it.
      });
  });

  // Progress saves from where playback starts; switching between picture and sound starts again.
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

  // A failed direct audio file is prepared again as a conversion, from where it stopped.
  const failAudio = useStableCallback((failure: PlaybackSourceFailure | "direct") => {
    const media = audioRef.current;
    const position = media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
    failedAt.current = Math.max(failedAt.current, position);
    if ((failure === "transcode" || failure === "direct") && !forceTranscode) {
      setForceTranscode(true);
      setPhase((current) =>
        current.kind === "playing" ? { kind: "playing", startAt: Math.max(current.startAt, position) } : current,
      );
      return;
    }
    setError({ busy: failure === "busy" });
  });

  // Audio plays once the start position and the source are known.
  useEffect(() => {
    const media = audioRef.current;
    if (!listening || startAt === null || !media || !playback) return;
    const detach = attachPlaybackSource(media, playback, { startPosition: startAt, onFailure: failAudio });
    const begin = () => {
      if (startAt > 0 && startAt < (media.duration || Infinity) && Math.abs(media.currentTime - startAt) > 1) {
        media.currentTime = startAt;
      }
      void media.play().catch(() => {
        // Autoplay can be refused; the native controls still start playback.
      });
    };
    media.addEventListener("loadedmetadata", begin, { once: true });
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") tracker.current?.pause(media.currentTime, media.duration);
    };
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      media.removeEventListener("loadedmetadata", begin);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      tracker.current?.close(media.currentTime, media.duration);
      detach();
    };
  }, [failAudio, listening, playback, startAt]);

  const sidecars = useMemo<VideoSubtitle[]>(
    () =>
      subtitle?.streamUrl ? [{ locationId: subtitle.id, title: baseName(subtitle.name), url: subtitle.streamUrl }] : [],
    [subtitle],
  );

  // Switching between picture and sound continues from the same moment.
  const toggleAudioOnly = () => {
    const position = listening ? audioRef.current?.currentTime : stage.current?.currentTime();
    if (phase.kind === "playing" && position !== undefined && Number.isFinite(position)) {
      setPhase({ kind: "playing", startAt: position });
    }
    onAudioOnlyChange(!audioOnly);
  };

  const audioEvents = {
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) =>
      tracker.current?.timeUpdate(event.currentTarget.currentTime, event.currentTarget.duration),
    onPause: (event: SyntheticEvent<HTMLMediaElement>) => {
      if (!event.currentTarget.ended)
        tracker.current?.pause(event.currentTarget.currentTime, event.currentTarget.duration);
    },
    onPlay: pauseAudio,
    onEnded: (event: SyntheticEvent<HTMLMediaElement>) => tracker.current?.ended(event.currentTarget.duration),
    onError: () => {
      if (playback?.delivery === "direct") failAudio("direct");
    },
  };
  const playing = phase.kind === "playing";
  const controls = playing && playback !== null;
  const loading = !error && (phase.kind === "checking" || (playing && playback === null));
  const picture = asset.thumbnailUrl ?? artworkUrl;
  // The stage's shortcuts work while focus is on the player rather than on a button.
  const handleKeyDown =
    !listening && controls
      ? (event: ReactKeyboardEvent<HTMLDivElement>) => stage.current?.handleKeyDown(event)
      : undefined;

  const retry = () => {
    setError(null);
    setSource({ listening, forceTranscode, playback: null });
    if (listening && phase.kind === "playing") setPhase({ kind: "playing", startAt: failedAt.current });
    setRetryToken((value) => value + 1);
  };

  const overlays = (
    <>
      {error && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center"
        >
          <p className="text-sm text-muted-foreground">
            {t(error.busy ? "records.player.busy" : "records.player.unavailable")}
          </p>
          <Button variant="outline" onClick={retry}>
            {t("records.retry")}
          </Button>
        </div>
      )}
      {loading && <Loader2 className="absolute h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />}
      {phase.kind === "prompt" && !error && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
          <div
            role="group"
            aria-label={t("records.player.resumePrompt", { time: formatPlaybackTime(phase.position) })}
            className="flex flex-wrap items-center justify-center gap-3 rounded-lg border bg-background/90 px-4 py-3 shadow-xl backdrop-blur"
          >
            <span className="text-sm font-medium">
              {t("records.player.resumePrompt", { time: formatPlaybackTime(phase.position) })}
            </span>
            <div className="flex gap-2">
              <Button autoFocus onClick={() => setPhase({ kind: "playing", startAt: phase.position })}>
                {t("records.player.resume")}
              </Button>
              <Button variant="outline" onClick={() => setPhase({ kind: "playing", startAt: 0 })}>
                {t("records.player.startOver")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <RecordOverlay
      label={t(isVideo ? "records.player.label" : "records.player.audioLabel", { name: title })}
      onClose={onClose}
      onKeyDown={handleKeyDown}
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-2 sm:gap-2 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t("records.player.close")}
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium sm:text-base">{title}</h2>
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("records.player.position", { current: index + 1, total })}
          </p>
        </div>
        {/* Shortcuts need a keyboard, so phones leave the guide out. */}
        {!phone && !listening && <RecordShortcutsButton />}
        {isVideo && (
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            aria-label={t("records.player.audioOnly")}
            title={t("records.player.audioOnly")}
            aria-pressed={audioOnly}
            onClick={toggleAudioOnly}
          >
            <Headphones className="h-5 w-5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t(isVideo ? "records.player.previous" : "records.player.previousTrack")}
          title={t(isVideo ? "records.player.previous" : "records.player.previousTrack")}
          disabled={previousId === null}
          onClick={() => previousId !== null && onStep(previousId)}
        >
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t(isVideo ? "records.player.next" : "records.player.nextTrack")}
          title={t(isVideo ? "records.player.next" : "records.player.nextTrack")}
          disabled={nextId === null}
          onClick={() => nextId !== null && onStep(nextId)}
        >
          <ChevronRight className="h-6 w-6" />
        </Button>
      </div>
      {listening ? (
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          <div className="flex h-full w-full min-h-0 flex-col items-center justify-center gap-6 px-4 pb-6">
            <div className="grid aspect-square min-h-0 w-full max-w-[min(20rem,45vh)] shrink place-items-center overflow-hidden rounded-xl border bg-muted">
              {picture ? (
                <img src={assetURL(picture)} alt="" className="h-full w-full object-cover" />
              ) : (
                <Music className="h-16 w-16 text-muted-foreground/70" strokeWidth={1.5} aria-hidden="true" />
              )}
            </div>
            <audio
              ref={audioRef}
              className="w-full max-w-xl shrink-0"
              controls={controls}
              preload="metadata"
              {...audioEvents}
            />
          </div>
          {overlays}
        </div>
      ) : (
        // The stage fits both the width and the height, so the controls stay on screen.
        <VideoStage
          ref={stage}
          playback={playing ? playback : null}
          start={startAt === null ? null : { position: startAt, playing: true }}
          subtitles={sidecars}
          fallbackDuration={asset.durationSeconds ?? 0}
          poster={asset.thumbnailUrl}
          layout="fill"
          controls={controls}
          enterFullscreen={phone && playing}
          onFailure={failVideo}
          onPlay={pauseAudio}
          onPosition={trackVideo}
        >
          {overlays}
        </VideoStage>
      )}
    </RecordOverlay>
  );
}

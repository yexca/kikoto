import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, assetURL, type RecordAsset, type RecordProgress } from "@/lib/api";
import { usePlayer } from "@/player/PlayerProvider";

import { RecordOverlay } from "./RecordOverlay";
import { RecordProgressTracker, resumePosition } from "./recordProgress";
import { baseName, formatPlaybackTime } from "./recordsModel";

type Phase =
  | { kind: "checking" }
  | { kind: "prompt"; position: number }
  | { kind: "playing"; startAt: number }
  | { kind: "error" };

/**
 * The full-screen Record video player. It asks whether to continue from a
 * saved position, saves progress while the video plays, and steps through the
 * folder's videos. Remount it per video (`key`) so each video starts with its
 * own progress.
 */
export function RecordVideoPlayer({
  video,
  subtitle,
  index,
  total,
  previousId,
  nextId,
  knownProgress,
  autoResume,
  canSaveProgress,
  onStep,
  onClose,
  onProgressSaved,
}: {
  video: RecordAsset;
  subtitle?: RecordAsset;
  index: number;
  total: number;
  previousId: number | null;
  nextId: number | null;
  /** Progress the grid already read for this video, if any. */
  knownProgress?: RecordProgress;
  /** Continue from the saved position without asking, as the folder's Continue action does. */
  autoResume: boolean;
  canSaveProgress: boolean;
  onStep: (id: number) => void;
  onClose: () => void;
  onProgressSaved: (id: number, progress: RecordProgress) => void;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLVideoElement | null>(null);
  const tracker = useRef<RecordProgressTracker | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const title = baseName(video.name);

  // Decide where playback starts: the saved position, after asking unless the
  // folder's Continue action opened the player, or the beginning.
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
        .getRecordProgress(video.id, controller.signal)
        .then((progress) => {
          if (!controller.signal.aborted) decide(progress);
        })
        .catch(() => {
          if (!controller.signal.aborted) decide(undefined);
        });
    return () => controller.abort();
  }, [decide, initialProgress, video.id]);

  // Start playback once the start position is chosen, and save progress from then on.
  const startAt = phase.kind === "playing" ? phase.startAt : null;
  // A record video takes over from the global audio player when it starts;
  // the audio stays paused after the video closes.
  const player = usePlayer();
  const pauseAudio = useStableCallback(() => {
    if (player.isPlaying) player.pause();
  });
  const save = useStableCallback((progress: RecordProgress) => {
    if (!canSaveProgress) return;
    void api
      .updateRecordProgress(video.id, progress)
      .then(() => onProgressSaved(video.id, progress))
      .catch(() => {
        // Progress is best effort; playback continues without it.
      });
  });
  useEffect(() => {
    const media = element.current;
    if (startAt === null || !media) return;
    const current = new RecordProgressTracker(save, startAt);
    tracker.current = current;
    const begin = () => {
      if (startAt > 0 && startAt < (media.duration || Infinity)) media.currentTime = startAt;
      void media.play().catch(() => {
        // Autoplay can be refused; the native controls still start playback.
      });
    };
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) begin();
    else media.addEventListener("loadedmetadata", begin, { once: true });
    const saveWhenHidden = () => {
      if (document.visibilityState === "hidden") current.pause(media.currentTime, media.duration);
    };
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => {
      media.removeEventListener("loadedmetadata", begin);
      document.removeEventListener("visibilitychange", saveWhenHidden);
      current.close(media.currentTime, media.duration);
      if (tracker.current === current) tracker.current = null;
    };
  }, [save, startAt]);

  return (
    <RecordOverlay label={t("records.player.label", { name: title })} onClose={onClose}>
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
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t("records.player.previous")}
          title={t("records.player.previous")}
          disabled={previousId === null}
          onClick={() => previousId !== null && onStep(previousId)}
        >
          <ChevronLeft className="h-6 w-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label={t("records.player.next")}
          title={t("records.player.next")}
          disabled={nextId === null}
          onClick={() => nextId !== null && onStep(nextId)}
        >
          <ChevronRight className="h-6 w-6" />
        </Button>
      </div>
      <div className="relative grid min-h-0 flex-1 place-items-center">
        {phase.kind === "error" ? (
          <p role="alert" className="px-6 text-center text-sm text-muted-foreground">
            {t("records.player.unavailable")}
          </p>
        ) : (
          <video
            ref={element}
            className="h-full max-h-full w-full object-contain"
            controls={phase.kind === "playing"}
            playsInline
            preload="metadata"
            src={video.streamUrl ? assetURL(video.streamUrl) : undefined}
            onTimeUpdate={(event) =>
              tracker.current?.timeUpdate(event.currentTarget.currentTime, event.currentTarget.duration)
            }
            onPause={(event) => {
              if (!event.currentTarget.ended)
                tracker.current?.pause(event.currentTarget.currentTime, event.currentTarget.duration);
            }}
            onPlay={pauseAudio}
            onEnded={(event) => tracker.current?.ended(event.currentTarget.duration)}
            onError={() => setPhase({ kind: "error" })}
          >
            {subtitle?.streamUrl && (
              <track kind="subtitles" src={assetURL(subtitle.streamUrl)} label={baseName(subtitle.name)} default />
            )}
          </video>
        )}
        {phase.kind === "checking" && (
          <Loader2 className="absolute h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
        {phase.kind === "prompt" && (
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
      </div>
    </RecordOverlay>
  );
}

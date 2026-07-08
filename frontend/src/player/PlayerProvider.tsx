import {
  Captions,
  ListMusic,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { api, assetURL, type MediaProgress } from "@/lib/api";

export type PlayMode = "order" | "loop" | "single";
type DockMode = "full" | "compact" | "mini";

export type PlayerTrack = {
  mediaItemId: number;
  locationId: number;
  title: string;
  folderPath: string;
  locationType: string;
  streamUrl: string;
  sizeBytes: number | null;
  availability: string;
  workId: number;
  workCode: string;
  workTitle: string;
  coverUrl: string;
  circle: string;
  progress: MediaProgress | null;
  progressRecordable: boolean;
  lyricsLocationId: number | null;
  lyricsTitle: string;
  remoteSourceId?: number;
  remoteWorkCode?: string;
  remotePath?: string;
};

type PlayerContextValue = {
  queue: PlayerTrack[];
  currentIndex: number;
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  mode: PlayMode;
  playQueue: (tracks: PlayerTrack[], locationId: number) => void;
  selectTrack: (index: number) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seekBy: (seconds: number) => void;
  seekTo: (seconds: number) => void;
  setVolume: (volume: number) => void;
  cycleMode: () => void;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volumeValue, setVolumeValue] = useState(0.9);
  const [mode, setMode] = useState<PlayMode>("order");
  const restoredMediaItemRef = useRef<number | null>(null);
  const lastSavedRef = useRef<{ mediaItemId: number; position: number; at: number } | null>(null);
  const cacheRequestedRef = useRef<Set<string>>(new Set());
  const currentTrack = queue[currentIndex] ?? null;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volumeValue;
  }, [volumeValue]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    audio.src = assetURL(currentTrack.streamUrl);
    setCurrentTime(0);
    setDuration(0);
    restoredMediaItemRef.current = null;
    if (isPlaying) {
      void audio.play().catch(() => setIsPlaying(false));
    }
  }, [currentTrack?.locationId]);

  useEffect(() => {
    if (!currentTrack || currentTrack.locationType !== "remote_stream") return;
    const cacheKey = remoteCacheKey(currentTrack);
    if (cacheRequestedRef.current.has(cacheKey)) return;
    cacheRequestedRef.current.add(cacheKey);
    api.getRuntimeSettings()
      .then((settings) => {
        if (settings.cacheEnabled) {
          if (currentTrack.locationId > 0) {
            void api.cacheMediaLocation(currentTrack.locationId).catch(() => {});
          } else if (currentTrack.remoteSourceId && currentTrack.remoteWorkCode && currentTrack.remotePath) {
            void api.cacheRemoteSourceWorkMedia(currentTrack.remoteSourceId, currentTrack.remoteWorkCode, currentTrack.remotePath).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [currentTrack?.locationId, currentTrack?.locationType, currentTrack?.remoteSourceId, currentTrack?.remoteWorkCode, currentTrack?.remotePath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack || restoredMediaItemRef.current === currentTrack.mediaItemId) return;
    const position = currentTrack.progress?.completed ? 0 : (currentTrack.progress?.positionSeconds ?? 0);
    if (position > 0 && Number.isFinite(position)) {
      const restore = () => {
        audio.currentTime = Math.min(position, audio.duration || position);
        setCurrentTime(audio.currentTime);
        restoredMediaItemRef.current = currentTrack.mediaItemId;
      };
      if (audio.readyState >= 1) {
        restore();
      } else {
        audio.addEventListener("loadedmetadata", restore, { once: true });
        return () => audio.removeEventListener("loadedmetadata", restore);
      }
    } else {
      restoredMediaItemRef.current = currentTrack.mediaItemId;
    }
  }, [currentTrack?.mediaItemId, currentTrack?.locationId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (isPlaying) {
      void audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTrack]);

  const playQueue = (tracks: PlayerTrack[], locationId: number) => {
    if (tracks.length === 0) return;
    const nextIndex = Math.max(
      0,
      tracks.findIndex((track) => track.locationId === locationId),
    );
    setQueue(tracks);
    setCurrentIndex(nextIndex);
    setIsPlaying(true);
  };

  const selectTrack = (index: number) => {
    if (index < 0 || index >= queue.length) return;
    setCurrentIndex(index);
    setIsPlaying(true);
  };

  const next = () => {
    setCurrentIndex((index) => {
      if (queue.length === 0) return 0;
      if (index < queue.length - 1) return index + 1;
      return mode === "loop" ? 0 : index;
    });
    if (queue.length > 0) setIsPlaying(true);
  };

  const previous = () => {
    setCurrentIndex((index) => {
      if (queue.length === 0) return 0;
      if (index > 0) return index - 1;
      return mode === "loop" ? queue.length - 1 : index;
    });
    if (queue.length > 0) setIsPlaying(true);
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(seconds)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
  };

  const seekBy = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    seekTo(audio.currentTime + seconds);
  };

  const saveProgress = (completed: boolean, force = false) => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (!currentTrack.progressRecordable) return;
    if (currentTrack.mediaItemId <= 0) return;
    const position = completed ? audio.duration || audio.currentTime : audio.currentTime;
    if (!Number.isFinite(position) || position < 0) return;
    const durationValue = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
    const now = Date.now();
    const lastSaved = lastSavedRef.current;
    if (
      !force &&
      lastSaved?.mediaItemId === currentTrack.mediaItemId &&
      now - lastSaved.at < 10_000 &&
      Math.abs(position - lastSaved.position) < 8
    ) {
      return;
    }
    lastSavedRef.current = { mediaItemId: currentTrack.mediaItemId, position, at: now };
    void api.updateMediaProgress(currentTrack.mediaItemId, {
      positionSeconds: position,
      durationSeconds: durationValue,
      completed,
    });
  };

  const handleEnded = () => {
    const audio = audioRef.current;
    saveProgress(true, true);
    if (mode === "single" && audio) {
      audio.currentTime = 0;
      void audio.play();
      return;
    }
    if (currentIndex < queue.length - 1) {
      setCurrentIndex((index) => index + 1);
      setIsPlaying(true);
      return;
    }
    if (mode === "loop" && queue.length > 0) {
      setCurrentIndex(0);
      setIsPlaying(true);
      return;
    }
    setIsPlaying(false);
  };

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      volume: volumeValue,
      mode,
      playQueue,
      selectTrack,
      togglePlay: () => setIsPlaying((value) => (currentTrack ? !value : false)),
      next,
      previous,
      seekBy,
      seekTo,
      setVolume: setVolumeValue,
      cycleMode: () => setMode((value) => (value === "order" ? "loop" : value === "loop" ? "single" : "order")),
    }),
    [queue, currentIndex, currentTrack, isPlaying, currentTime, duration, volumeValue, mode],
  );

  return (
    <PlayerContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
          saveProgress(false);
        }}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          saveProgress(false, true);
          setIsPlaying(false);
        }}
        onEnded={handleEnded}
      />
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) {
    throw new Error("usePlayer must be used inside PlayerProvider");
  }
  return value;
}

function remoteCacheKey(track: PlayerTrack) {
  if (track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return `source:${track.remoteSourceId}:${track.remoteWorkCode}:${track.remotePath}`;
  }
  return `location:${track.locationId}`;
}

export function PlayerDock() {
  const player = usePlayer();
  const volumeButtonRef = useRef<HTMLButtonElement | null>(null);
  const volumePopoverRef = useRef<HTMLDivElement | null>(null);
  const [dockMode, setDockMode] = useState<DockMode>(() => (window.matchMedia("(min-width: 1024px)").matches ? "full" : "compact"));
  const [panel, setPanel] = useState<"queue" | "lyrics" | null>(null);
  const [isVolumeOpen, setIsVolumeOpen] = useState(false);
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const track = player.currentTrack;
  const seekFromMiniPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (player.duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const angle = Math.atan2(y, x) + Math.PI / 2;
    const normalized = angle < 0 ? angle + Math.PI * 2 : angle;
    player.seekTo((normalized / (Math.PI * 2)) * player.duration);
  };
  const parsedLyrics = useMemo(() => parseTimedLyrics(lyricsText ?? ""), [lyricsText]);
  const activeLyricIndex = useMemo(() => activeTimedLyricIndex(parsedLyrics.lines, player.currentTime), [parsedLyrics.lines, player.currentTime]);

  useEffect(() => {
    setLyricsText(null);
    setLyricsError("");
    if (!track?.lyricsLocationId) return;
    api.getMediaText(track.lyricsLocationId)
      .then((result) => setLyricsText(result.content))
      .catch((error) => setLyricsError(error instanceof Error ? error.message : "Lyrics preview failed."));
  }, [track?.lyricsLocationId]);

  useEffect(() => {
    if (!isVolumeOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (volumeButtonRef.current?.contains(target) || volumePopoverRef.current?.contains(target)) {
        return;
      }
      setIsVolumeOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isVolumeOpen]);

  if (!track) return null;

  const progress = player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0;
  const modeLabel = player.mode === "order" ? "Order" : player.mode === "loop" ? "Loop" : "Repeat one";
  const hasPanel = panel !== null;

  if (dockMode === "mini") {
    return (
      <div className="fixed bottom-[76px] right-3 z-40 lg:bottom-6 lg:right-6">
        <div
          className="relative h-[92px] w-[92px] animate-player-enter rounded-full bg-card shadow-xl transition-all duration-300 ease-out"
          onPointerDown={seekFromMiniPointer}
          onPointerMove={(event) => {
            if (event.buttons === 1) seekFromMiniPointer(event);
          }}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(player.duration || 0)}
          aria-valuenow={Math.round(player.currentTime)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              player.seekBy(-5);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              player.seekBy(5);
            }
          }}
        >
          <MiniProgress progress={progress} />
          <button
            className="absolute inset-[9px] z-10 overflow-hidden rounded-full bg-background"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={player.togglePlay}
            onDoubleClick={() => setDockMode("compact")}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            title="Double-click to expand"
          >
            <CoverImage track={track} className="h-full w-full rounded-full" />
            <span className="absolute inset-0 grid place-items-center bg-background/10 opacity-0 transition-opacity hover:opacity-100">
              {player.isPlaying ? <Pause className="h-5 w-5 drop-shadow" /> : <Play className="h-5 w-5 drop-shadow" />}
            </span>
          </button>
          <Button
            className="absolute -right-1 -top-1 z-30 h-7 w-7 rounded-full"
            size="icon"
            variant="secondary"
            onClick={() => setDockMode("compact")}
            aria-label="Expand player"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  if (dockMode === "compact") {
    return (
      <div className="fixed inset-x-3 bottom-[76px] z-40 lg:inset-auto lg:bottom-6 lg:right-6 lg:w-[390px]">
        <div className="relative animate-player-enter overflow-hidden rounded-lg border bg-card shadow-lg transition-all duration-300 ease-out">
          <div className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-300" style={{ width: `${progress}%` }} />
          <div className="relative z-10 flex min-h-[68px] items-center gap-3 px-3">
            <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setDockMode("full")}>
              <CoverImage track={track} className="h-12 w-16" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{track.title}</div>
                <div className="truncate text-xs text-muted-foreground">{track.workTitle}</div>
              </div>
            </button>
            <Button size="icon" variant="outline" onClick={() => setDockMode("mini")} aria-label="Mini player">
              <Minimize2 className="h-4 w-4" />
            </Button>
            <Button size="icon" onClick={player.togglePlay} aria-label={player.isPlaying ? "Pause" : "Play"}>
              {player.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="fixed inset-x-3 bottom-[76px] z-40 h-[560px] max-h-[calc(100vh-96px)] animate-player-enter overflow-hidden rounded-lg border bg-card shadow-xl transition-all duration-300 ease-out lg:inset-auto lg:bottom-6 lg:right-6 lg:h-[620px] lg:w-[390px]">
      <div className="flex h-full flex-col">
        <button
          className="flex h-9 shrink-0 items-center justify-center border-b hover:bg-muted"
          onClick={() => setDockMode("compact")}
          aria-label="Collapse player"
        >
          <span className="h-1.5 w-12 rounded-full bg-muted-foreground/35" />
        </button>

        <div className="min-h-0 flex-1 space-y-4 overflow-hidden p-4">
          {hasPanel ? (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex min-h-[72px] items-center gap-3 rounded-md border bg-background p-2">
                <CoverImage track={track} className="h-14 w-[74px]" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{track.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{track.workTitle}</div>
                  <div className="truncate text-xs text-muted-foreground">{track.workCode}</div>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-2">
                {panel === "lyrics" ? (
                  track.lyricsLocationId ? (
                    lyricsError ? (
                      <div className="p-3 text-sm text-muted-foreground">{lyricsError}</div>
                    ) : lyricsText === null ? (
                      <LyricsLoadingSkeleton />
                    ) : (
                      <LyricsPanel
                        title={track.lyricsTitle}
                        text={lyricsText}
                        parsed={parsedLyrics}
                        activeIndex={activeLyricIndex}
                      />
                    )
                  ) : (
                    <div className="p-3 text-sm text-muted-foreground">No lyrics matched for this track.</div>
                  )
                ) : (
                  <div className="space-y-1">
                    {player.queue.map((item, index) => (
                      <button
                        key={item.locationId}
                        className={`flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs ${
                          index === player.currentIndex ? "bg-secondary font-semibold" : "hover:bg-muted"
                        }`}
                        onClick={() => player.selectTrack(index)}
                      >
                        {index === player.currentIndex ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        <span className="truncate">{item.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col justify-center gap-4">
              <CoverImage track={track} className="mx-auto aspect-[4/3] w-full max-w-[260px]" />
              <div className="space-y-1 text-center">
                <div className="line-clamp-2 text-base font-semibold">{track.title}</div>
                <div className="line-clamp-2 text-sm text-muted-foreground">{track.workTitle}</div>
                <div className="truncate text-xs text-muted-foreground">{track.circle || track.folderPath || "Local audio"}</div>
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 space-y-4 border-t p-4">
          <div className="space-y-1">
          <input
            className="h-2 w-full accent-primary"
            type="range"
            min={0}
            max={player.duration || 0}
            step={0.1}
            value={Math.min(player.currentTime, player.duration || player.currentTime)}
            onChange={(event) => player.seekTo(Number(event.currentTarget.value))}
            aria-label="Seek"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatTime(player.currentTime)}</span>
            <span>{formatTime(player.duration)}</span>
          </div>
          </div>

          <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="icon" onClick={player.previous} aria-label="Previous">
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => player.seekBy(-5)} aria-label="Back 5 seconds">
            <SeekIcon direction="back" seconds={5} />
          </Button>
          <Button className="h-12 w-12" size="icon" onClick={player.togglePlay} aria-label={player.isPlaying ? "Pause" : "Play"}>
            {player.isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </Button>
          <Button variant="outline" size="icon" onClick={() => player.seekBy(10)} aria-label="Forward 10 seconds">
            <SeekIcon direction="forward" seconds={10} />
          </Button>
          <Button variant="outline" size="icon" onClick={player.next} aria-label="Next">
            <SkipForward className="h-4 w-4" />
          </Button>
          </div>

          <div className="relative grid grid-cols-4 gap-2">
          <Button variant="outline" size="sm" onClick={player.cycleMode} title={modeLabel}>
            {player.mode === "single" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
          </Button>
          <Button
            variant={panel === "queue" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setPanel((value) => (value === "queue" ? null : "queue"))}
          >
            <ListMusic className="h-4 w-4" />
          </Button>
          <Button
            variant={panel === "lyrics" ? "secondary" : "outline"}
            size="sm"
            onClick={() => setPanel((value) => (value === "lyrics" ? null : "lyrics"))}
            disabled={!track.lyricsLocationId}
            title={track.lyricsLocationId ? "Lyrics" : "No matched lyrics"}
          >
            <Captions className="h-4 w-4" />
          </Button>
          <Button
            ref={volumeButtonRef}
            variant={isVolumeOpen ? "secondary" : "outline"}
            size="sm"
            onClick={() => setIsVolumeOpen((value) => !value)}
          >
            <Volume2 className="h-4 w-4" />
          </Button>

          {isVolumeOpen && (
            <div
              ref={volumePopoverRef}
              className="absolute bottom-11 right-0 z-10 flex h-44 w-14 flex-col items-center gap-2 rounded-md border bg-card px-2 py-3 shadow-lg"
            >
              <span className="text-xs text-muted-foreground">{Math.round(player.volume * 100)}</span>
              <input
                className="h-24 w-2 accent-primary [direction:rtl] [writing-mode:vertical-lr]"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={player.volume}
                onChange={(event) => player.setVolume(Number(event.currentTarget.value))}
                aria-label="Volume"
              />
              <Volume2 className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SeekIcon({ direction, seconds }: { direction: "back" | "forward"; seconds: number }) {
  const Icon = direction === "back" ? RotateCcw : RotateCw;
  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center">
      <Icon className="h-5 w-5" />
      <span className="absolute text-[8px] font-bold leading-none">{seconds}</span>
    </span>
  );
}

function LyricsLoadingSkeleton() {
  return (
    <div className="space-y-3 p-3" aria-label="Loading lyrics">
      <div className="mx-auto h-4 w-32 animate-pulse rounded bg-muted" />
      <div className="space-y-2 pt-2">
        <div className="mx-auto h-4 w-4/5 animate-pulse rounded bg-muted" />
        <div className="mx-auto h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mx-auto h-4 w-5/6 animate-pulse rounded bg-muted" />
        <div className="mx-auto h-4 w-3/5 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

function MiniProgress({ progress }: { progress: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.max(0, Math.min(100, progress)) / 100) * circumference;
  return (
    <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={radius} fill="none" stroke="currentColor" strokeWidth="6" className="text-border" />
      <circle
        cx="50"
        cy="50"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="text-primary transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

type TimedLyricLine = {
  time: number;
  text: string;
};

type ParsedLyrics = {
  timed: boolean;
  lines: TimedLyricLine[];
};

function LyricsPanel({
  title,
  text,
  parsed,
  activeIndex,
}: {
  title: string;
  text: string;
  parsed: ParsedLyrics;
  activeIndex: number;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  if (!parsed.timed) {
    return (
      <div className="space-y-3 p-3">
        <div className="truncate text-xs font-semibold text-muted-foreground">{title}</div>
        <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <div className="truncate text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="space-y-1 py-12 text-center">
        {parsed.lines.map((line, index) => {
          const active = index === activeIndex;
          return (
            <div
              key={`${line.time}:${index}`}
              ref={active ? activeRef : undefined}
              className={`rounded-md px-2 py-1.5 text-sm leading-relaxed transition-all duration-300 ${
                active ? "bg-primary/10 text-base font-semibold text-primary" : "text-muted-foreground"
              }`}
            >
              {line.text || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CoverImage({ track, className }: { track: PlayerTrack; className: string }) {
  return track.coverUrl ? (
    <img src={assetURL(track.coverUrl)} alt="" className={`${className} shrink-0 rounded-md bg-muted object-contain`} />
  ) : (
    <div className={`${className} grid shrink-0 place-items-center rounded-md bg-secondary text-sm font-bold text-secondary-foreground`}>
      {track.workCode.slice(0, 2)}
    </div>
  );
}

function formatTime(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function parseTimedLyrics(text: string): ParsedLyrics {
  const lrcLines: TimedLyricLine[] = [];
  const sourceLines = text.split(/\r?\n/);
  for (const rawLine of sourceLines) {
    const timestamps = Array.from(rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g));
    if (timestamps.length === 0) continue;
    const lineText = rawLine.replace(/\[[^\]]+\]/g, "").trim();
    for (const match of timestamps) {
      lrcLines.push({ time: timestampToSeconds(match[1], match[2], match[3]), text: lineText });
    }
  }
  if (lrcLines.length > 0) {
    return { timed: true, lines: lrcLines.sort((left, right) => left.time - right.time) };
  }

  const cueLines: TimedLyricLine[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const match = sourceLines[index].match(/(\d{1,2}:)?(\d{1,2}):(\d{2})([,.]\d{1,3})?\s*-->/);
    if (!match) continue;
    const textLines: string[] = [];
    index += 1;
    while (index < sourceLines.length && sourceLines[index].trim() !== "") {
      textLines.push(sourceLines[index].trim());
      index += 1;
    }
    cueLines.push({ time: cueTimestampToSeconds(match[0].split("-->")[0].trim()), text: textLines.join(" ") });
  }
  return cueLines.length > 0
    ? { timed: true, lines: cueLines.sort((left, right) => left.time - right.time) }
    : { timed: false, lines: [] };
}

function activeTimedLyricIndex(lines: TimedLyricLine[], currentTime: number) {
  if (lines.length === 0) return -1;
  let active = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time > currentTime + 0.15) break;
    active = index;
  }
  return active;
}

function timestampToSeconds(minutes: string, seconds: string, fraction = "0") {
  const normalizedFraction = Number(`0.${fraction.padEnd(3, "0").slice(0, 3)}`);
  return Number(minutes) * 60 + Number(seconds) + normalizedFraction;
}

function cueTimestampToSeconds(value: string) {
  const parts = value.replace(",", ".").split(":");
  const secondsPart = Number(parts.pop() ?? 0);
  const minutesPart = Number(parts.pop() ?? 0);
  const hoursPart = Number(parts.pop() ?? 0);
  return hoursPart * 3600 + minutesPart * 60 + secondsPart;
}

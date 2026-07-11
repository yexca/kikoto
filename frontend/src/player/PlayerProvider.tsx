import {
  ArrowDown,
  ArrowUp,
  Captions,
  CircleDot,
  Gauge,
  HardDrive,
  ListMusic,
  ListOrdered,
  Maximize2,
  PanelBottom,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ANDROID_BACK_EVENT } from "@/app/events";
import { api, assetURL, type MediaProgress } from "@/lib/api";
import { useAuth } from "@/auth/AuthProvider";
import {
  abandonNativeAudioFocus,
  addNativeMediaListeners,
  requestNativeAudioFocus,
  requestNativeNotificationPermission,
  stopNativeMedia,
  supportsNativeMedia,
  updateNativeMedia,
} from "@/lib/nativeMedia";

export type PlayMode = "order" | "loop" | "single";
type DockMode = "full" | "compact" | "mini";
const LYRIC_PREVIEW_ROW_HEIGHT = 28;

export type PlayerTrack = {
  queueItemId?: string;
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
  lyricsChoices?: { mediaItemId: number; locationId: number; title: string; path: string; reason: string }[];
  autoLyricsLocationId?: number | null;
  preferredLyricsMediaItemId?: number | null;
  remoteSourceId?: number;
  remoteWorkCode?: string;
  remotePath?: string;
  locations?: PlayerTrackLocation[];
};

export type PlayerTrackLocation = {
  locationId: number;
  locationType: string;
  streamUrl: string;
  sourceId: number;
  sourceName: string;
  availability: string;
};

type SleepTimerState = {
  mode: "deadline";
  deadline: number;
  finishCurrentTrack: boolean;
  waitingForTrackEnd: boolean;
} | null;

type PlayerContextValue = {
  queue: PlayerTrack[];
  currentIndex: number;
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  sleepTimer: SleepTimerState;
  sleepRemainingSeconds: number;
  mode: PlayMode;
  playQueue: (tracks: PlayerTrack[], locationId: number) => void;
  selectTrack: (index: number) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  seekBy: (seconds: number) => void;
  seekTo: (seconds: number) => void;
  cyclePlaybackRate: () => void;
  playNext: (track: PlayerTrack) => void;
  appendQueue: (tracks: PlayerTrack[]) => void;
  moveQueueItem: (queueItemId: string, direction: -1 | 1) => void;
  removeQueueItem: (queueItemId: string) => void;
  clearQueue: () => void;
  selectLocation: (locationId: number) => void;
  setSleepTimerMinutes: (minutes: number, finishCurrentTrack: boolean) => void;
  setSleepFinishCurrentTrack: (enabled: boolean) => void;
  clearSleepTimer: () => void;
  cycleMode: () => void;
  setMode: (mode: PlayMode) => void;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);
type LibraryPlayerContextValue = {
  currentLocationId: number | null;
  playQueue: (tracks: PlayerTrack[], locationId: number) => void;
  playNext: (track: PlayerTrack) => void;
  appendQueue: (tracks: PlayerTrack[]) => void;
};

const LibraryPlayerContext = createContext<LibraryPlayerContextValue | null>(null);
const PLAYER_QUEUE_STORAGE_KEY = "kikoto:player-queue:v1";
const MINI_POSITION_STORAGE_KEY = "kikoto:player-mini-position:v1";

function loadPersistedQueue(): {
  queue: PlayerTrack[];
  currentIndex: number;
  mode: PlayMode;
  playbackRate: number;
  sleepTimer: SleepTimerState;
} {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYER_QUEUE_STORAGE_KEY) ?? "null") as {
      version?: number;
      queue?: PlayerTrack[];
      currentIndex?: number;
      mode?: PlayMode;
      playbackRate?: number;
      sleepTimer?: SleepTimerState | { mode: "track_end" };
    } | null;
    const queue = Array.isArray(parsed?.queue)
      ? parsed.queue.filter((track) => track && track.mediaItemId > 0 && track.streamUrl).map(withQueueIdentity)
      : [];
    const currentIndex = Math.max(0, Math.min(queue.length - 1, Number(parsed?.currentIndex) || 0));
    const mode = parsed?.mode === "loop" || parsed?.mode === "single" ? parsed.mode : "order";
    const playbackRate = [0.75, 1, 1.25, 1.5, 2].includes(Number(parsed?.playbackRate))
      ? Number(parsed?.playbackRate)
      : 1;
    const rawSleepTimer = parsed?.sleepTimer;
    const sleepTimer: SleepTimerState =
      rawSleepTimer?.mode === "track_end"
        ? { mode: "deadline", deadline: Date.now(), finishCurrentTrack: true, waitingForTrackEnd: true }
        : rawSleepTimer?.mode === "deadline" &&
            (rawSleepTimer.deadline > Date.now() || rawSleepTimer.waitingForTrackEnd)
          ? {
              mode: "deadline",
              deadline: rawSleepTimer.deadline,
              finishCurrentTrack: Boolean(rawSleepTimer.finishCurrentTrack),
              waitingForTrackEnd: Boolean(rawSleepTimer.waitingForTrackEnd),
            }
          : null;
    return { queue, currentIndex, mode, playbackRate, sleepTimer };
  } catch {
    return { queue: [], currentIndex: 0, mode: "order", playbackRate: 1, sleepTimer: null };
  }
}

function withQueueIdentity(track: PlayerTrack): PlayerTrack {
  if (track.queueItemId) return track;
  const randomID =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { ...track, queueItemId: randomID };
}

function locationPriority(locationType: string) {
  switch (locationType) {
    case "local":
      return 0;
    case "cache":
      return 1;
    case "remote_stream":
      return 2;
    default:
      return 3;
  }
}

function orderedTrackLocations(track: PlayerTrack | null) {
  if (!track) return [];
  const locations = track.locations?.length
    ? track.locations
    : [
        {
          locationId: track.locationId,
          locationType: track.locationType,
          streamUrl: track.streamUrl,
          sourceId: track.remoteSourceId ?? 0,
          sourceName: track.locationType,
          availability: track.availability,
        },
      ];
  return [...locations].sort(
    (left, right) => locationPriority(left.locationType) - locationPriority(right.locationType),
  );
}

function applyTrackLocation(track: PlayerTrack, location: PlayerTrackLocation): PlayerTrack {
  return {
    ...track,
    locationId: location.locationId,
    locationType: location.locationType,
    streamUrl: location.streamUrl,
    availability: location.availability,
  };
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const toast = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const restoredQueueRef = useRef(loadPersistedQueue());
  const [queue, setQueue] = useState<PlayerTrack[]>(restoredQueueRef.current.queue);
  const [currentIndex, setCurrentIndex] = useState(restoredQueueRef.current.currentIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(restoredQueueRef.current.playbackRate);
  const [mode, setMode] = useState<PlayMode>(restoredQueueRef.current.mode);
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(restoredQueueRef.current.sleepTimer);
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState(0);
  const restoredMediaItemRef = useRef<number | null>(null);
  const lastSavedRef = useRef<{ mediaItemId: number; position: number; at: number } | null>(null);
  const cacheRequestedRef = useRef<Set<string>>(new Set());
  const failedLocationIDsRef = useRef<Set<number>>(new Set());
  const notificationPermissionPromiseRef = useRef<Promise<boolean> | null>(null);
  const nativeControlRef = useRef({
    play: () => {},
    pause: () => {},
    previous: () => {},
    next: () => {},
    seekBackward: () => {},
    seekForward: () => {},
    seekTo: (_seconds: number) => {},
  });
  const currentTrack = queue[currentIndex] ?? null;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const deadlineFade =
      sleepTimer && !sleepTimer.waitingForTrackEnd && sleepRemainingSeconds > 0 && sleepRemainingSeconds <= 10
        ? Math.max(0, sleepRemainingSeconds / 10)
        : 1;
    const trackRemaining = Math.max(0, duration - currentTime);
    const trackEndFade =
      sleepTimer?.waitingForTrackEnd && duration > 0 && trackRemaining <= 10 ? trackRemaining / 10 : 1;
    audio.volume = Math.max(0, Math.min(1, Math.min(deadlineFade, trackEndFade)));
  }, [sleepTimer, sleepRemainingSeconds, currentTime, duration]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    const persistentQueue = queue.filter((track) => track.mediaItemId > 0 && track.progressRecordable);
    const currentQueueItemId = queue[currentIndex]?.queueItemId ?? "";
    const persistedCurrentIndex = Math.max(
      0,
      persistentQueue.findIndex((track) => track.queueItemId === currentQueueItemId),
    );
    localStorage.setItem(
      PLAYER_QUEUE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        queue: persistentQueue,
        currentIndex: persistedCurrentIndex,
        mode,
        playbackRate,
        sleepTimer,
        sleepRemainingSeconds,
      }),
    );
  }, [queue, currentIndex, mode, playbackRate, sleepTimer]);

  useEffect(() => {
    failedLocationIDsRef.current.clear();
  }, [currentTrack?.queueItemId, currentTrack?.mediaItemId]);

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
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (settings.cacheEnabled) {
          if (currentTrack.locationId > 0) {
            void api.cacheMediaLocation(currentTrack.locationId).catch(() => {});
          } else if (currentTrack.remoteSourceId && currentTrack.remoteWorkCode && currentTrack.remotePath) {
            void api
              .cacheRemoteSourceWorkMedia(
                currentTrack.remoteSourceId,
                currentTrack.remoteWorkCode,
                currentTrack.remotePath,
              )
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [
    currentTrack?.locationId,
    currentTrack?.locationType,
    currentTrack?.remoteSourceId,
    currentTrack?.remoteWorkCode,
    currentTrack?.remotePath,
  ]);

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

  const playQueue = useCallback((tracks: PlayerTrack[], locationId: number) => {
    if (tracks.length === 0) return;
    const normalizedTracks = tracks.map(withQueueIdentity);
    const nextIndex = Math.max(
      0,
      normalizedTracks.findIndex((track) => track.locationId === locationId),
    );
    setQueue(normalizedTracks);
    setCurrentIndex(nextIndex);
    setIsPlaying(true);
  }, []);

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
    if (!auth.user) return;
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

  useEffect(() => {
    if (!sleepTimer) {
      setSleepRemainingSeconds(0);
      return;
    }
    const checkDeadline = () => {
      if (sleepTimer.waitingForTrackEnd) {
        setSleepRemainingSeconds(0);
        return;
      }
      const remaining = Math.max(0, Math.ceil((sleepTimer.deadline - Date.now()) / 1000));
      setSleepRemainingSeconds(remaining);
      if (remaining > 0) return;
      const audio = audioRef.current;
      if (
        sleepTimer.finishCurrentTrack &&
        audio &&
        !audio.paused &&
        !audio.ended &&
        Number.isFinite(audio.duration) &&
        audio.duration > 0 &&
        audio.currentTime < audio.duration - 0.25
      ) {
        setSleepTimer((current) => (current ? { ...current, waitingForTrackEnd: true } : null));
        return;
      }
      saveProgress(false, true);
      setIsPlaying(false);
      setSleepTimer(null);
    };
    checkDeadline();
    const interval = window.setInterval(checkDeadline, 1000);
    document.addEventListener("visibilitychange", checkDeadline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkDeadline);
    };
  }, [sleepTimer]);

  const handleEnded = () => {
    const audio = audioRef.current;
    saveProgress(true, true);
    if (sleepTimer?.waitingForTrackEnd) {
      setSleepTimer(null);
      setIsPlaying(false);
      return;
    }
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

  const playNext = useCallback(
    (track: PlayerTrack) => {
      const nextTrack = withQueueIdentity(track);
      setQueue((items) => {
        const next = [...items];
        next.splice(Math.min(items.length, currentIndex + 1), 0, nextTrack);
        return next;
      });
    },
    [currentIndex],
  );

  const appendQueue = useCallback((tracks: PlayerTrack[]) => {
    if (tracks.length === 0) return;
    setQueue((items) => [...items, ...tracks.map(withQueueIdentity)]);
  }, []);

  const moveQueueItem = (queueItemId: string, direction: -1 | 1) => {
    setQueue((items) => {
      const from = items.findIndex((item) => item.queueItemId === queueItemId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= items.length) return items;
      const currentQueueItemId = items[currentIndex]?.queueItemId;
      const next = [...items];
      [next[from], next[to]] = [next[to], next[from]];
      if (currentQueueItemId) setCurrentIndex(next.findIndex((item) => item.queueItemId === currentQueueItemId));
      return next;
    });
  };

  const removeQueueItem = (queueItemId: string) => {
    setQueue((items) => {
      const removedIndex = items.findIndex((item) => item.queueItemId === queueItemId);
      if (removedIndex < 0) return items;
      const removingCurrent = removedIndex === currentIndex;
      const next = items.filter((item) => item.queueItemId !== queueItemId);
      if (next.length === 0) {
        setCurrentIndex(0);
        setIsPlaying(false);
      } else if (removedIndex < currentIndex) {
        setCurrentIndex((index) => Math.max(0, index - 1));
      } else if (removingCurrent) {
        setCurrentIndex(Math.min(removedIndex, next.length - 1));
      }
      return next;
    });
  };

  const clearQueue = () => {
    setQueue([]);
    setCurrentIndex(0);
    setIsPlaying(false);
    setSleepTimer(null);
  };

  const selectLocation = (locationId: number) => {
    failedLocationIDsRef.current.clear();
    setQueue((items) =>
      items.map((item, index) => {
        if (index !== currentIndex) return item;
        const location = item.locations?.find((candidate) => candidate.locationId === locationId);
        return location ? applyTrackLocation(item, location) : item;
      }),
    );
  };

  const tryNextLocation = () => {
    if (!currentTrack) return;
    failedLocationIDsRef.current.add(currentTrack.locationId);
    const locations = orderedTrackLocations(currentTrack);
    const nextLocation = locations.find(
      (location) =>
        location.locationId !== currentTrack.locationId &&
        !failedLocationIDsRef.current.has(location.locationId) &&
        (location.availability === "available" || location.availability === "remote"),
    );
    if (!nextLocation) {
      setIsPlaying(false);
      toast.error(`Playback failed: no working source remains for ${currentTrack.title}.`);
      return;
    }
    setQueue((items) =>
      items.map((item, index) => (index === currentIndex ? applyTrackLocation(item, nextLocation) : item)),
    );
    setIsPlaying(true);
    toast.warning(`Playback source failed. Switched to ${nextLocation.sourceName || nextLocation.locationType}.`);
  };

  useEffect(() => {
    nativeControlRef.current = {
      play: () => setIsPlaying((value) => (currentTrack ? true : value)),
      pause: () => setIsPlaying(false),
      previous,
      next,
      seekBackward: () => seekBy(-5),
      seekForward: () => seekBy(10),
      seekTo,
    };
  });

  useEffect(() => {
    if (!supportsNativeMedia()) return;
    let removeListeners: (() => void) | null = null;
    let disposed = false;
    addNativeMediaListeners({
      onControl: (event) => {
        const controls = nativeControlRef.current;
        switch (event.command) {
          case "play":
            controls.play();
            break;
          case "pause":
            controls.pause();
            break;
          case "previous":
            controls.previous();
            break;
          case "next":
            controls.next();
            break;
          case "seekBackward":
            controls.seekBackward();
            break;
          case "seekForward":
            controls.seekForward();
            break;
          case "seekTo":
            controls.seekTo((event.positionMs ?? 0) / 1000);
            break;
        }
      },
      onAudioFocus: (event) => {
        if (event.kind === "loss") nativeControlRef.current.pause();
      },
    }).then((remove) => {
      if (disposed) {
        remove();
        return;
      }
      removeListeners = remove;
    });
    return () => {
      disposed = true;
      removeListeners?.();
    };
  }, []);

  useEffect(() => {
    if (!supportsNativeMedia()) return;
    if (!currentTrack) {
      void stopNativeMedia();
      return;
    }
    let cancelled = false;
    async function syncNativeMedia() {
      if (isPlaying) {
        notificationPermissionPromiseRef.current ??= requestNativeNotificationPermission();
        await notificationPermissionPromiseRef.current;
      }
      if (cancelled) return;
      await updateNativeMedia({
        title: currentTrack.title || currentTrack.workTitle || "Kikoto",
        artist: currentTrack.circle || currentTrack.workTitle || "Kikoto",
        album: currentTrack.workTitle || currentTrack.workCode || "Kikoto",
        coverUrl: currentTrack.coverUrl ? new URL(assetURL(currentTrack.coverUrl), window.location.href).href : "",
        playing: isPlaying,
        positionMs: Math.max(0, Math.floor(currentTime * 1000)),
        durationMs: duration > 0 && Number.isFinite(duration) ? Math.floor(duration * 1000) : 0,
        playbackRate,
        canPrevious: currentIndex > 0 || mode === "loop",
        canNext: currentIndex < queue.length - 1 || mode === "loop",
      });
    }
    void syncNativeMedia();
    return () => {
      cancelled = true;
    };
  }, [currentTrack, currentIndex, queue.length, isPlaying, currentTime, duration, playbackRate, mode]);

  useEffect(() => {
    if (!supportsNativeMedia()) return;
    if (isPlaying && currentTrack) {
      void requestNativeAudioFocus();
    } else {
      void abandonNativeAudioFocus();
    }
  }, [isPlaying, currentTrack]);

  useEffect(
    () => () => {
      void stopNativeMedia();
    },
    [],
  );

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    if (currentTrack) {
      const artwork = currentTrack.coverUrl
        ? [{ src: new URL(assetURL(currentTrack.coverUrl), window.location.href).href }]
        : [];
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title,
        artist: currentTrack.circle || currentTrack.workTitle,
        album: currentTrack.workTitle,
        artwork,
      });
    } else {
      navigator.mediaSession.metadata = null;
    }
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ["play", () => setIsPlaying(true)],
      ["pause", () => setIsPlaying(false)],
      ["previoustrack", previous],
      ["nexttrack", next],
      ["seekbackward", (details) => seekBy(-(details.seekOffset ?? 5))],
      ["seekforward", (details) => seekBy(details.seekOffset ?? 10)],
      ["seekto", (details) => seekTo(details.seekTime ?? 0)],
    ];
    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers expose Media Session but not every action.
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore unsupported cleanup actions.
        }
      }
    };
  }, [
    currentTrack?.locationId,
    currentTrack?.title,
    currentTrack?.workTitle,
    currentTrack?.circle,
    currentTrack?.coverUrl,
    currentIndex,
    queue.length,
  ]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    if (duration > 0 && Number.isFinite(duration) && currentTime >= 0 && currentTime <= duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate,
          position: Math.min(currentTime, duration),
        });
      } catch {
        // Position state support varies across browsers.
      }
    }
  }, [isPlaying, currentTime, duration, playbackRate]);

  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      playbackRate,
      sleepTimer,
      sleepRemainingSeconds,
      mode,
      playQueue,
      selectTrack,
      togglePlay: () => setIsPlaying((value) => (currentTrack ? !value : false)),
      next,
      previous,
      seekBy,
      seekTo,
      cyclePlaybackRate: () =>
        setPlaybackRate((value) => {
          const rates = [0.75, 1, 1.25, 1.5, 2];
          const index = rates.indexOf(value);
          return rates[(index + 1) % rates.length];
        }),
      playNext,
      appendQueue,
      moveQueueItem,
      removeQueueItem,
      clearQueue,
      selectLocation,
      setSleepTimerMinutes: (minutes, finishCurrentTrack) =>
        setSleepTimer({
          mode: "deadline",
          deadline: Date.now() + Math.max(1, minutes) * 60_000,
          finishCurrentTrack,
          waitingForTrackEnd: false,
        }),
      setSleepFinishCurrentTrack: (enabled) =>
        setSleepTimer((current) => (current ? { ...current, finishCurrentTrack: enabled } : null)),
      clearSleepTimer: () => setSleepTimer(null),
      cycleMode: () => setMode((value) => (value === "order" ? "loop" : value === "loop" ? "single" : "order")),
      setMode,
    }),
    [
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      currentTime,
      duration,
      playbackRate,
      sleepTimer,
      sleepRemainingSeconds,
      mode,
    ],
  );
  const libraryValue = useMemo<LibraryPlayerContextValue>(
    () => ({
      currentLocationId: currentTrack?.locationId ?? null,
      playQueue,
      playNext,
      appendQueue,
    }),
    [currentTrack?.locationId, playQueue, playNext, appendQueue],
  );

  return (
    <LibraryPlayerContext.Provider value={libraryValue}>
      <PlayerContext.Provider value={value}>
        {children}
        <audio
          ref={audioRef}
          preload="metadata"
          onTimeUpdate={(event) => {
            setCurrentTime(event.currentTarget.currentTime);
            saveProgress(false);
          }}
          onDurationChange={(event) =>
            setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
          }
          onPlay={() => setIsPlaying(true)}
          onPause={() => {
            saveProgress(false, true);
            setIsPlaying(false);
          }}
          onEnded={handleEnded}
          onError={tryNextLocation}
        />
      </PlayerContext.Provider>
    </LibraryPlayerContext.Provider>
  );
}

export function usePlayer() {
  const value = useContext(PlayerContext);
  if (!value) {
    throw new Error("usePlayer must be used inside PlayerProvider");
  }
  return value;
}

export function useLibraryPlayer() {
  const value = useContext(LibraryPlayerContext);
  if (!value) {
    throw new Error("useLibraryPlayer must be used inside PlayerProvider");
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
  const toast = useToast();
  const isMobile = useIsMobilePlayer();
  const sleepButtonRef = useRef<HTMLButtonElement | null>(null);
  const sleepPopoverRef = useRef<HTMLDivElement | null>(null);
  const fullMainRef = useRef<HTMLDivElement | null>(null);
  const [dockMode, setDockMode] = useState<DockMode>(() =>
    window.matchMedia("(min-width: 1024px)").matches ? "full" : "compact",
  );
  const [panel, setPanel] = useState<"queue" | "lyrics" | null>(null);
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [lyricsError, setLyricsError] = useState("");
  const [activeLyricsLocationId, setActiveLyricsLocationId] = useState<number | null>(null);
  const [usingAutomaticLyrics, setUsingAutomaticLyrics] = useState(true);
  const [lyricsPreferenceOverrides, setLyricsPreferenceOverrides] = useState<Record<number, number | null>>({});
  const [miniPosition, setMiniPosition] = useState<{ x: number; y: number } | null>(() => restoreMiniPosition());
  const [miniActionsOpen, setMiniActionsOpen] = useState(false);
  const [isSleepOpen, setIsSleepOpen] = useState(false);
  const [isCustomSleepOpen, setIsCustomSleepOpen] = useState(false);
  const [customSleepMinutes, setCustomSleepMinutes] = useState("90");
  const [finishCurrentTrack, setFinishCurrentTrack] = useState(false);
  const [isSourceOpen, setIsSourceOpen] = useState(false);
  const miniDragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  const miniActionsTimerRef = useRef<number | null>(null);
  const coverTapRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const [fullDragOffset, setFullDragOffset] = useState(0);
  const [lyricsPreviewRows, setLyricsPreviewRows] = useState(3);
  const fullDragRef = useRef<{ pointerId: number; startY: number; startedAt: number; moved: boolean } | null>(null);
  const suppressCollapseClickRef = useRef(false);
  const desktopFullHeight = useDesktopFullPlayerHeight(isMobile);
  const track = player.currentTrack;
  const parsedLyrics = useMemo(() => parseTimedLyrics(lyricsText ?? ""), [lyricsText]);
  const activeLyricIndex = useMemo(
    () => activeTimedLyricIndex(parsedLyrics.lines, player.currentTime),
    [parsedLyrics.lines, player.currentTime],
  );
  const activeLyricsChoice = track?.lyricsChoices?.find((choice) => choice.locationId === activeLyricsLocationId);

  useEffect(() => {
    if (!track) {
      setActiveLyricsLocationId(null);
      setUsingAutomaticLyrics(true);
      return;
    }
    const hasOverride = Object.prototype.hasOwnProperty.call(lyricsPreferenceOverrides, track.mediaItemId);
    const preferredMediaItemId = hasOverride
      ? lyricsPreferenceOverrides[track.mediaItemId]
      : track.preferredLyricsMediaItemId;
    const preferredChoice = track.lyricsChoices?.find((choice) => choice.mediaItemId === preferredMediaItemId);
    setActiveLyricsLocationId(
      preferredChoice?.locationId ?? track.autoLyricsLocationId ?? track.lyricsLocationId ?? null,
    );
    setUsingAutomaticLyrics(!preferredMediaItemId);
  }, [lyricsPreferenceOverrides, track]);

  const changeLyricsChoice = async (locationId: number | null) => {
    if (!track) return;
    if (locationId === null) {
      setLyricsPreferenceOverrides((current) => ({ ...current, [track.mediaItemId]: null }));
      setUsingAutomaticLyrics(true);
      setActiveLyricsLocationId(track.autoLyricsLocationId ?? null);
      try {
        await api.clearMediaLyricsPreference(track.mediaItemId);
      } catch (error) {
        toast.notify({
          kind: "warning",
          message: error instanceof Error ? error.message : "Lyrics preference could not be cleared.",
        });
      }
      return;
    }
    const choice = track.lyricsChoices?.find((item) => item.locationId === locationId);
    if (!choice) return;
    setLyricsPreferenceOverrides((current) => ({ ...current, [track.mediaItemId]: choice.mediaItemId }));
    setUsingAutomaticLyrics(false);
    setActiveLyricsLocationId(locationId);
    try {
      await api.setMediaLyricsPreference(track.mediaItemId, choice.mediaItemId);
    } catch (error) {
      toast.notify({
        kind: "warning",
        message: error instanceof Error ? error.message : "Lyrics preference could not be saved.",
      });
    }
  };

  useEffect(() => {
    setLyricsText(null);
    setLyricsError("");
    if (!activeLyricsLocationId) return;
    api
      .getMediaText(activeLyricsLocationId)
      .then((result) => setLyricsText(result.content))
      .catch((error) => setLyricsError(error instanceof Error ? error.message : "Lyrics preview failed."));
  }, [activeLyricsLocationId]);

  useEffect(() => {
    if (!isSleepOpen) return;
    setFinishCurrentTrack(Boolean(player.sleepTimer?.finishCurrentTrack));
    if (player.sleepTimer && !player.sleepTimer.waitingForTrackEnd) {
      setCustomSleepMinutes(String(Math.max(1, Math.ceil((player.sleepTimer.deadline - Date.now()) / 60_000))));
    }
    setIsCustomSleepOpen(false);
  }, [isSleepOpen]);

  useEffect(() => {
    if (!isSleepOpen) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setIsSleepOpen(false);
        return;
      }
      const target = event.target as Node | null;
      if (target && (sleepButtonRef.current?.contains(target) || sleepPopoverRef.current?.contains(target))) return;
      setIsSleepOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
    };
  }, [isSleepOpen]);

  useEffect(() => {
    if (!miniActionsOpen || !isMobile) return;
    if (miniActionsTimerRef.current !== null) window.clearTimeout(miniActionsTimerRef.current);
    miniActionsTimerRef.current = window.setTimeout(() => setMiniActionsOpen(false), 3000);
    return () => {
      if (miniActionsTimerRef.current !== null) window.clearTimeout(miniActionsTimerRef.current);
    };
  }, [isMobile, miniActionsOpen]);

  useEffect(
    () => () => {
      if (miniActionsTimerRef.current !== null) window.clearTimeout(miniActionsTimerRef.current);
    },
    [],
  );

  const showDesktopMiniActions = () => {
    if (isMobile) return;
    if (miniActionsTimerRef.current !== null) window.clearTimeout(miniActionsTimerRef.current);
    miniActionsTimerRef.current = null;
    setMiniActionsOpen(true);
  };

  const hideDesktopMiniActionsLater = () => {
    if (isMobile) return;
    if (miniActionsTimerRef.current !== null) window.clearTimeout(miniActionsTimerRef.current);
    miniActionsTimerRef.current = window.setTimeout(() => {
      miniActionsTimerRef.current = null;
      setMiniActionsOpen(false);
    }, 900);
  };

  useEffect(() => {
    const handleResize = () =>
      setMiniPosition((current) => (current ? clampMiniPosition(current) : restoreMiniPosition()));
    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.playerActive = track ? "true" : "false";
    document.documentElement.dataset.playerMode = track ? dockMode : "none";
    return () => {
      delete document.documentElement.dataset.playerActive;
      delete document.documentElement.dataset.playerMode;
    };
  }, [track, dockMode]);

  useEffect(() => {
    if (!isMobile || dockMode !== "full") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, dockMode]);

  useEffect(() => {
    if (!isMobile) return;
    const handleBack = (event: Event) => {
      if (isSleepOpen) {
        setIsSleepOpen(false);
        event.preventDefault();
        return;
      }
      if (isCustomSleepOpen) {
        setIsCustomSleepOpen(false);
        event.preventDefault();
        return;
      }
      if (isSourceOpen) {
        setIsSourceOpen(false);
        event.preventDefault();
        return;
      }
      if (panel) {
        setPanel(null);
        event.preventDefault();
        return;
      }
      if (miniActionsOpen) {
        setMiniActionsOpen(false);
        event.preventDefault();
        return;
      }
      if (dockMode === "full") {
        setDockMode("compact");
        event.preventDefault();
      }
    };
    window.addEventListener(ANDROID_BACK_EVENT, handleBack);
    return () => window.removeEventListener(ANDROID_BACK_EVENT, handleBack);
  }, [dockMode, isCustomSleepOpen, isMobile, isSleepOpen, isSourceOpen, miniActionsOpen, panel]);

  useEffect(() => {
    if (dockMode !== "full" || panel) return;
    setLyricsPreviewRows((rows) => Math.max(rows, 3));
    const container = fullMainRef.current;
    if (!container) return;
    let frame = 0;
    let settleFrame = 0;
    const measure = () => {
      const cover = container.querySelector<HTMLElement>("[data-player-cover-shell]");
      const title = container.querySelector<HTMLElement>("[data-player-title-block]");
      const containerHeight = container.getBoundingClientRect().height;
      const coverHeight = cover?.getBoundingClientRect().height ?? 0;
      const titleHeight = title?.getBoundingClientRect().height ?? 0;
      if (containerHeight < 320 || coverHeight < 120 || titleHeight < 24) return;
      const reservedGap = 36;
      const available = containerHeight - coverHeight - titleHeight - reservedGap;
      const nextRows = Math.max(1, Math.min(10, Math.floor(available / LYRIC_PREVIEW_ROW_HEIGHT)));
      setLyricsPreviewRows((rows) => (rows === nextRows ? rows : nextRows));
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
      frame = requestAnimationFrame(() => {
        settleFrame = requestAnimationFrame(measure);
      });
    };
    scheduleMeasure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(container);
    container.querySelectorAll<HTMLElement>("[data-player-measure]").forEach((element) => observer.observe(element));
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settleFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [desktopFullHeight, dockMode, panel, track?.locationId, track?.title, track?.workTitle]);

  if (!track) return null;

  const progress = player.duration > 0 ? Math.min(100, (player.currentTime / player.duration) * 100) : 0;
  const modeLabel = player.mode === "order" ? "Order" : player.mode === "loop" ? "Loop" : "Repeat one";
  const availableLocations = orderedTrackLocations(track);
  const currentLocation =
    availableLocations.find((location) => location.locationId === track.locationId) ?? availableLocations[0];
  const hasPanel = panel !== null;
  const openWorkDetail = () => {
    if (!track.workCode) return;
    if (isMobile) setDockMode("compact");
    window.history.pushState(
      { returnTo: window.location.pathname + window.location.search, returnLabel: "Back" },
      "",
      `/${encodeURIComponent(track.workCode)}`,
    );
    window.dispatchEvent(new Event("kikoto:navigation"));
  };
  const handleCoverClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!isMobile) return;
    const now = performance.now();
    if (event.detail >= 2) {
      coverTapRef.current = null;
      openWorkDetail();
      return;
    }
    const previous = coverTapRef.current;
    coverTapRef.current = { at: now, x: event.clientX, y: event.clientY };
    if (!previous) return;
    const closeInTime = now - previous.at <= 360;
    const closeInSpace = Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 28;
    if (closeInTime && closeInSpace) {
      coverTapRef.current = null;
      openWorkDetail();
    }
  };
  const miniActions = miniActionLayout(miniPosition);

  if (dockMode === "mini") {
    return (
      <div
        className={`mini-player group fixed z-40 touch-none ${miniActionsOpen ? "actions-open" : ""}`}
        style={
          miniPosition
            ? { left: miniPosition.x, top: miniPosition.y }
            : { bottom: "calc(76px + env(safe-area-inset-bottom))", right: "12px" }
        }
        onPointerEnter={showDesktopMiniActions}
        onPointerLeave={hideDesktopMiniActionsLater}
        onFocusCapture={showDesktopMiniActions}
        onBlurCapture={hideDesktopMiniActionsLater}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement | null)?.closest("[data-mini-action]")) return;
          const rect = event.currentTarget.getBoundingClientRect();
          miniDragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = miniDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (drag.moved) setMiniActionsOpen(false);
          const nextX = Math.max(8, Math.min(window.innerWidth - 100, event.clientX - drag.offsetX));
          const bottomLimit = isMobile ? 84 + safeAreaBottom() : 8;
          const nextY = Math.max(8, Math.min(window.innerHeight - 92 - bottomLimit, event.clientY - drag.offsetY));
          if (!drag.moved && miniPosition) {
            drag.moved = Math.abs(nextX - miniPosition.x) > 4 || Math.abs(nextY - miniPosition.y) > 4;
          } else if (!drag.moved) {
            const rect = event.currentTarget.getBoundingClientRect();
            drag.moved = Math.abs(nextX - rect.left) > 4 || Math.abs(nextY - rect.top) > 4;
          }
          setMiniPosition({ x: nextX, y: nextY });
        }}
        onPointerUp={(event) => {
          const drag = miniDragRef.current;
          miniDragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (!drag) return;
          if (!drag.moved) {
            if (isMobile) setMiniActionsOpen((value) => !value);
            else showDesktopMiniActions();
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          const snappedX = rect.left + 46 < window.innerWidth / 2 ? 8 : window.innerWidth - 100;
          const snapped = clampMiniPosition({ x: snappedX, y: rect.top });
          setMiniPosition(snapped);
          persistMiniPosition(snapped);
        }}
        onPointerCancel={() => {
          miniDragRef.current = null;
        }}
      >
        <div className="relative h-[92px] w-[92px] animate-player-enter cursor-grab rounded-full border border-primary/20 bg-card shadow-xl shadow-primary/15 ring-4 ring-primary/10 transition-all duration-300 ease-out active:cursor-grabbing">
          <MiniProgress progress={progress} />
          <div
            className="pointer-events-none absolute inset-[9px] z-10 overflow-hidden rounded-full bg-background shadow-inner"
            aria-hidden="true"
          >
            <CoverImage track={track} className="h-full w-full rounded-full" />
          </div>
          <button
            data-mini-action
            className="mini-action absolute left-1/2 top-1/2 z-20 grid h-11 w-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/50 bg-background/72 text-foreground shadow-lg backdrop-blur transition-all duration-200 active:scale-95 dark:border-white/10 dark:bg-background/62"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              player.togglePlay();
            }}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            title={player.isPlaying ? "Pause" : "Play"}
          >
            {player.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <Button
            data-mini-action
            className={`mini-action absolute z-20 h-9 w-9 rounded-full border-primary/20 bg-secondary/95 shadow-lg transition-all duration-200 ${miniActions.compactClass}`}
            size="icon"
            variant="secondary"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={() => {
              setMiniActionsOpen(false);
              setDockMode("compact");
            }}
            aria-label="Open compact player"
            title="Compact"
          >
            <PanelBottom className="h-4 w-4" />
          </Button>
          <Button
            data-mini-action
            className={`mini-action absolute z-20 h-9 w-9 rounded-full border-primary/20 bg-secondary/95 shadow-lg transition-all duration-200 ${miniActions.fullClass}`}
            size="icon"
            variant="secondary"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={() => {
              setMiniActionsOpen(false);
              setDockMode("full");
            }}
            aria-label="Open full player"
            title="Full"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  if (dockMode === "compact") {
    return (
      <div className="fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] z-40 lg:inset-auto lg:bottom-6 lg:right-6 lg:w-[390px]">
        <div className="relative animate-player-enter overflow-hidden rounded-[22px] border border-white/35 bg-card/75 shadow-2xl shadow-primary/15 backdrop-blur-2xl transition-all duration-300 ease-out dark:border-white/10 dark:bg-card/70">
          <div
            className="absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
          <div className="relative z-10 flex min-h-[72px] items-center gap-3 px-3">
            <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setDockMode("full")}>
              <CoverImage track={track} className="h-12 w-16 rounded-xl shadow-sm" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{track.title}</div>
                <div className="truncate text-xs text-muted-foreground">{track.workTitle}</div>
              </div>
            </button>
            <Button
              className="h-9 w-9 rounded-full border-primary/15 bg-card/80"
              size="icon"
              variant="outline"
              onClick={() => setDockMode("mini")}
              aria-label="Mini player"
            >
              <CircleDot className="h-4 w-4" />
            </Button>
            <Button
              className="h-11 w-11 rounded-full"
              size="icon"
              onClick={player.togglePlay}
              aria-label={player.isPlaying ? "Pause" : "Play"}
            >
              {player.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      className="fixed inset-0 z-50 h-[100dvh] animate-player-enter overflow-hidden border-0 bg-background/95 text-foreground shadow-xl backdrop-blur-2xl transition-[transform,opacity,height] duration-200 ease-out lg:inset-auto lg:bottom-6 lg:right-6 lg:w-[390px] lg:rounded-[28px] lg:border lg:border-white/35 lg:bg-card/82 dark:lg:border-white/10 dark:lg:bg-card/78"
      style={
        {
          ...(!isMobile ? { height: desktopFullHeight } : {}),
          ...(isMobile && fullDragOffset > 0
            ? { transform: `translateY(${fullDragOffset}px)`, opacity: Math.max(0.55, 1 - fullDragOffset / 500) }
            : {}),
        }
      }
    >
      <div className="pointer-events-none absolute inset-0 bg-background/82" aria-hidden="true" />
      <div
        className="relative z-10 flex h-full flex-col pt-[env(safe-area-inset-top)]"
        style={{ touchAction: panel ? undefined : "pan-x" }}
        onPointerDown={(event) => {
          if (!isMobile) return;
          const target = event.target as HTMLElement;
          const isHandle = Boolean(target.closest("[data-player-handle]"));
          const isPanelDragZone = Boolean(target.closest("[data-player-drag-zone]"));
          if (panel && !isHandle && !isPanelDragZone) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (!isHandle && event.clientY > rect.top + rect.height * 0.6) return;
          if (target.closest("input, [data-player-no-drag]")) return;
          fullDragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startedAt: performance.now(),
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = fullDragRef.current;
          if (!isMobile || !drag || drag.pointerId !== event.pointerId) return;
          const offset = Math.max(0, event.clientY - drag.startY);
          if (offset > 6) drag.moved = true;
          setFullDragOffset(offset);
        }}
        onPointerUp={(event) => {
          const drag = fullDragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          fullDragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          const offset = Math.max(0, event.clientY - drag.startY);
          const elapsed = Math.max(1, performance.now() - drag.startedAt);
          const velocity = offset / elapsed;
          suppressCollapseClickRef.current = drag.moved;
          if (offset >= 96 || velocity >= 0.55) setDockMode("compact");
          setFullDragOffset(0);
        }}
        onPointerCancel={() => {
          fullDragRef.current = null;
          setFullDragOffset(0);
        }}
      >
        <button
          data-player-handle
          className="flex h-10 shrink-0 touch-none items-center justify-center hover:bg-white/20 lg:h-8"
          onClick={() => {
            if (suppressCollapseClickRef.current) {
              suppressCollapseClickRef.current = false;
              return;
            }
            setDockMode("compact");
          }}
          aria-label="Collapse player"
        >
          <span className="h-1.5 w-12 rounded-full bg-muted-foreground/25" />
        </button>

        <div ref={fullMainRef} className="min-h-0 flex-1 space-y-4 overflow-hidden px-4 pb-4">
          {hasPanel ? (
            <div className="animate-player-panel-enter flex h-full min-h-0 flex-col gap-3">
              <div
                data-player-drag-zone
                className="flex min-h-[76px] touch-none items-center gap-3 rounded-2xl border border-white/30 bg-white/25 p-2.5 shadow-inner dark:border-white/10 dark:bg-white/5"
              >
                <CoverImage track={track} className="h-14 w-[74px] rounded-xl shadow-sm" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{track.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{track.workTitle}</div>
                  <div className="truncate text-xs text-muted-foreground">{track.workCode}</div>
                </div>
              </div>
              <div className="player-panel-scroll min-h-0 flex-1 overflow-auto rounded-2xl border border-white/30 bg-background/55 p-2 shadow-inner dark:border-white/10 dark:bg-background/40">
                {panel === "lyrics" ? (
                  activeLyricsLocationId ? (
                    lyricsError ? (
                      <div className="p-3 text-sm text-muted-foreground">{lyricsError}</div>
                    ) : lyricsText === null ? (
                      <LyricsLoadingSkeleton />
                    ) : (
                      <LyricsPanel
                        title={activeLyricsChoice?.title ?? track.lyricsTitle}
                        text={lyricsText}
                        parsed={parsedLyrics}
                        activeIndex={activeLyricIndex}
                        choices={track.lyricsChoices ?? []}
                        activeLocationId={activeLyricsLocationId}
                        automatic={usingAutomaticLyrics}
                        onChoiceChange={(locationId) => void changeLyricsChoice(locationId)}
                      />
                    )
                  ) : (
                    <div className="p-3 text-sm text-muted-foreground">No lyrics matched for this track.</div>
                  )
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
                      <span>{player.queue.length} queued</span>
                      <button
                        className="rounded px-2 py-1 hover:bg-muted hover:text-foreground"
                        onClick={player.clearQueue}
                      >
                        Clear
                      </button>
                    </div>
                    {player.queue.map((item, index) => (
                      <div
                        key={item.queueItemId ?? `${item.locationId}:${index}`}
                        className={`flex min-h-11 w-full items-center gap-1 rounded-md border-l-2 px-1.5 text-xs transition-colors ${
                          index === player.currentIndex
                            ? "border-primary bg-secondary/80 font-semibold text-secondary-foreground"
                            : "border-transparent hover:bg-muted"
                        }`}
                      >
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left"
                          onClick={() => player.selectTrack(index)}
                        >
                          {index === player.currentIndex ? (
                            <Pause className="h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : (
                            <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{item.title}</span>
                        </button>
                        <button
                          className="grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-background/70 disabled:opacity-30"
                          disabled={index === 0}
                          onClick={() => item.queueItemId && player.moveQueueItem(item.queueItemId, -1)}
                          aria-label={`Move ${item.title} up`}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-background/70 disabled:opacity-30"
                          disabled={index === player.queue.length - 1}
                          onClick={() => item.queueItemId && player.moveQueueItem(item.queueItemId, 1)}
                          aria-label={`Move ${item.title} down`}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="grid h-8 w-8 shrink-0 place-items-center rounded hover:bg-background/70"
                          onClick={() => item.queueItemId && player.removeQueueItem(item.queueItemId)}
                          aria-label={`Remove ${item.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col justify-center gap-3 py-2">
              <button
                data-player-cover-shell
                data-player-measure
                className="mx-auto w-full max-w-[min(86vw,340px)] touch-manipulation rounded-[24px] bg-white/25 p-2 shadow-inner transition-transform duration-200 hover:scale-[1.015] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/5 lg:max-w-[282px]"
                onClick={handleCoverClick}
                onDoubleClick={isMobile ? undefined : openWorkDetail}
                title="Double-click to open work detail"
                aria-label="Open work detail"
              >
                <CoverImage
                  track={track}
                  className="mx-auto aspect-[4/3] w-full rounded-[20px] shadow-lg"
                />
              </button>
              <div data-player-title-block data-player-measure className="space-y-1 text-center">
                <div className="line-clamp-2 text-base font-semibold">{track.title}</div>
                <div className="line-clamp-2 text-sm text-muted-foreground">{track.workTitle}</div>
              </div>
              {parsedLyrics.timed && activeLyricIndex >= 0 ? (
                <InlineLyricsPreview
                  parsed={parsedLyrics}
                  activeIndex={activeLyricIndex}
                  rows={lyricsPreviewRows}
                  onOpen={() => setPanel("lyrics")}
                />
              ) : (
                <LyricsPreviewState
                  hasLyrics={Boolean(activeLyricsLocationId)}
                  loading={Boolean(activeLyricsLocationId && lyricsText === null && !lyricsError)}
                  error={lyricsError}
                  onOpen={() => setPanel("lyrics")}
                />
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 space-y-4 border-t border-white/30 bg-background/55 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 dark:border-white/10 lg:bg-white/25 lg:p-4 dark:lg:bg-white/5">
          <div className="relative flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {player.currentIndex + 1} / {player.queue.length}
            </span>
            <button
              className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-primary/15 bg-card/55 px-2.5 py-1 hover:bg-muted"
              onClick={() => setIsSourceOpen((value) => !value)}
              data-player-no-drag
              aria-label="Choose playback source"
            >
              <HardDrive className="h-3.5 w-3.5 shrink-0" />
              <span className="max-w-36 truncate">
                {currentLocation?.sourceName || currentLocation?.locationType || "Playback source"}
              </span>
            </button>
            {isSourceOpen && (
              <div className="absolute bottom-8 right-0 z-20 w-60 rounded-lg border bg-card p-1.5 text-card-foreground shadow-xl">
                {availableLocations.map((location) => (
                  <button
                    key={`${location.locationId}:${location.locationType}`}
                    className={`flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm hover:bg-muted ${location.locationId === track.locationId ? "bg-secondary" : ""}`}
                    onClick={() => {
                      player.selectLocation(location.locationId);
                      setIsSourceOpen(false);
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{location.sourceName || location.locationType}</span>
                      <span className="block text-xs text-muted-foreground">{location.locationType}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{location.availability}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <SeekBar
              currentTime={player.currentTime}
              duration={player.duration}
              progress={progress}
              onSeek={player.seekTo}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatTime(player.currentTime)}</span>
              <span>{formatTime(player.duration)}</span>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2">
            <Button
              className="h-10 w-10 rounded-full border-white/40 bg-card/55 shadow-sm backdrop-blur hover:bg-white/40 dark:border-white/10 dark:bg-card/45"
              variant="outline"
              size="icon"
              onClick={player.previous}
              aria-label="Previous"
            >
              <SkipBack className="h-4 w-4" />
            </Button>
            <Button
              className="h-10 w-10 rounded-full border-white/40 bg-card/55 shadow-sm backdrop-blur hover:bg-white/40 dark:border-white/10 dark:bg-card/45"
              variant="outline"
              size="icon"
              onClick={() => player.seekBy(-5)}
              aria-label="Back 5 seconds"
            >
              <SeekIcon direction="back" seconds={5} />
            </Button>
            <Button
              className="h-14 w-14 rounded-full transition-transform active:scale-95"
              size="icon"
              onClick={player.togglePlay}
              aria-label={player.isPlaying ? "Pause" : "Play"}
            >
              {player.isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </Button>
            <Button
              className="h-10 w-10 rounded-full border-white/40 bg-card/55 shadow-sm backdrop-blur hover:bg-white/40 dark:border-white/10 dark:bg-card/45"
              variant="outline"
              size="icon"
              onClick={() => player.seekBy(10)}
              aria-label="Forward 10 seconds"
            >
              <SeekIcon direction="forward" seconds={10} />
            </Button>
            <Button
              className="h-10 w-10 rounded-full border-white/40 bg-card/55 shadow-sm backdrop-blur hover:bg-white/40 dark:border-white/10 dark:bg-card/45"
              variant="outline"
              size="icon"
              onClick={player.next}
              aria-label="Next"
            >
              <SkipForward className="h-4 w-4" />
            </Button>
          </div>

          <div className="relative grid grid-cols-5 gap-2">
            <Button
              className="rounded-full border-primary/15"
              variant={player.mode === "order" ? "outline" : "secondary"}
              size="sm"
              onClick={player.cycleMode}
              aria-label={`${modeLabel}. Change playback mode`}
              title={modeLabel}
            >
              {player.mode === "order" ? (
                <ListOrdered className="h-4 w-4" />
              ) : player.mode === "loop" ? (
                <Repeat className="h-4 w-4" />
              ) : (
                <Repeat1 className="h-4 w-4" />
              )}
            </Button>

            <Button
              className="rounded-full border-primary/15"
              variant={panel === "queue" ? "secondary" : "outline"}
              size="sm"
              onClick={() => setPanel((value) => (value === "queue" ? null : "queue"))}
              aria-label="Playback queue"
              title="Playback queue"
            >
              <ListMusic className="h-4 w-4" />
            </Button>
            <Button
              className="rounded-full border-primary/15"
              variant={panel === "lyrics" ? "secondary" : "outline"}
              size="sm"
              onClick={() => setPanel((value) => (value === "lyrics" ? null : "lyrics"))}
              disabled={!track.lyricsLocationId}
              aria-label="Lyrics"
              title={track.lyricsLocationId ? "Lyrics" : "No matched lyrics"}
            >
              <Captions className="h-4 w-4" />
            </Button>
            <Button
              className="rounded-full border-primary/15"
              variant={player.playbackRate === 1 ? "outline" : "secondary"}
              size="sm"
              onClick={player.cyclePlaybackRate}
              aria-label={`Playback speed ${player.playbackRate} times`}
              title="Playback speed"
            >
              <Gauge className="h-4 w-4" />
              <span className="text-[10px]">{player.playbackRate}×</span>
            </Button>

            <Button
              ref={sleepButtonRef}
              className="rounded-full border-primary/15"
              variant={player.sleepTimer ? "secondary" : "outline"}
              size="sm"
              onClick={() => setIsSleepOpen((value) => !value)}
              aria-label="Sleep timer"
              title="Sleep timer"
            >
              <Timer className="h-4 w-4" />
              {player.sleepTimer && (
                <span className="text-[10px]">
                  {player.sleepTimer.waitingForTrackEnd ? "Track" : formatSleepRemaining(player.sleepRemainingSeconds)}
                </span>
              )}
            </Button>

            <AnchoredPopover
              open={isSleepOpen}
              anchorRef={sleepButtonRef}
              className="w-[min(14rem,calc(100vw-1.5rem))] rounded-lg border bg-card p-0 text-card-foreground shadow-xl"
            >
              <div ref={sleepPopoverRef} className="p-2">
                <div className="flex items-center justify-between px-2 pb-2 text-xs font-semibold text-muted-foreground">
                  <span>Sleep timer</span>
                  {player.sleepTimer && (
                    <span>
                      {player.sleepTimer.waitingForTrackEnd
                        ? "Finishing track"
                        : formatSleepRemaining(player.sleepRemainingSeconds)}
                    </span>
                  )}
                </div>
                <label className="mb-1 flex min-h-10 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-sm hover:bg-muted">
                  <span>
                    <span className="block font-medium">Finish current track</span>
                    <span className="block text-xs text-muted-foreground">After the timer expires</span>
                  </span>
                  <Switch
                    checked={finishCurrentTrack}
                    onCheckedChange={(enabled) => {
                      setFinishCurrentTrack(enabled);
                      if (player.sleepTimer) player.setSleepFinishCurrentTrack(enabled);
                    }}
                    aria-label="Finish current track"
                  />
                </label>
                {[30, 60].map((minutes) => (
                  <button
                    key={minutes}
                    className="flex h-9 w-full items-center rounded-md px-2 text-sm hover:bg-muted"
                    onClick={() => {
                      player.setSleepTimerMinutes(minutes, finishCurrentTrack);
                      setIsSleepOpen(false);
                    }}
                  >
                    {minutes} min
                  </button>
                ))}
                <button
                  className="flex h-9 w-full items-center rounded-md px-2 text-sm hover:bg-muted"
                  onClick={() => setIsCustomSleepOpen((value) => !value)}
                  aria-expanded={isCustomSleepOpen}
                >
                  Custom
                </button>
                {isCustomSleepOpen && (
                  <div className="flex items-center gap-2 px-2 py-2">
                    <label className="min-w-0 flex-1 text-xs text-muted-foreground">
                      Minutes
                      <input
                        className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                        type="number"
                        min={1}
                        max={1440}
                        step={1}
                        inputMode="numeric"
                        value={customSleepMinutes}
                        onChange={(event) => setCustomSleepMinutes(event.currentTarget.value)}
                        aria-label="Custom sleep minutes"
                      />
                    </label>
                    <Button
                      className="mt-5"
                      size="sm"
                      disabled={!validSleepMinutes(customSleepMinutes)}
                      onClick={() => {
                        player.setSleepTimerMinutes(Number(customSleepMinutes), finishCurrentTrack);
                        setIsSleepOpen(false);
                      }}
                    >
                      Set
                    </Button>
                  </div>
                )}
                {player.sleepTimer && (
                  <button
                    className="mt-1 flex h-9 w-full items-center rounded-md px-2 text-sm text-destructive hover:bg-muted"
                    onClick={() => {
                      player.clearSleepTimer();
                      setIsSleepOpen(false);
                    }}
                  >
                    <X className="mr-2 h-4 w-4" /> Cancel timer
                  </button>
                )}
              </div>
            </AnchoredPopover>
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

function useIsMobilePlayer() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 1023px)").matches);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function useDesktopFullPlayerHeight(isMobile: boolean) {
  const [height, setHeight] = useState(() => desktopFullPlayerHeight());

  useEffect(() => {
    if (isMobile) return;
    const update = () => setHeight(desktopFullPlayerHeight());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isMobile]);

  return height;
}

function desktopFullPlayerHeight() {
  const viewportHeight = window.innerHeight;
  return Math.round(Math.min(720, Math.max(560, viewportHeight * 0.62)));
}

function safeAreaBottom() {
  const footer = document.querySelector("footer");
  return footer ? Number.parseFloat(window.getComputedStyle(footer).paddingBottom) || 0 : 0;
}

function miniVerticalBounds() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const bottomLimit = 84 + safeAreaBottom();
  return { min: 8, max: Math.max(8, viewportHeight - 92 - bottomLimit) };
}

function clampMiniPosition(position: { x: number; y: number }) {
  const bounds = miniVerticalBounds();
  return {
    x: Math.max(8, Math.min(window.innerWidth - 100, position.x)),
    y: Math.max(bounds.min, Math.min(bounds.max, position.y)),
  };
}

function restoreMiniPosition() {
  try {
    const stored = JSON.parse(localStorage.getItem(MINI_POSITION_STORAGE_KEY) ?? "null") as {
      side?: "left" | "right";
      verticalRatio?: number;
    } | null;
    if (!stored || (stored.side !== "left" && stored.side !== "right") || !Number.isFinite(stored.verticalRatio))
      return null;
    const bounds = miniVerticalBounds();
    const ratio = Math.max(0, Math.min(1, Number(stored.verticalRatio)));
    return {
      x: stored.side === "left" ? 8 : window.innerWidth - 100,
      y: bounds.min + (bounds.max - bounds.min) * ratio,
    };
  } catch {
    return null;
  }
}

function persistMiniPosition(position: { x: number; y: number }) {
  const bounds = miniVerticalBounds();
  const verticalRatio = bounds.max > bounds.min ? (position.y - bounds.min) / (bounds.max - bounds.min) : 0;
  localStorage.setItem(
    MINI_POSITION_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      side: position.x + 46 < window.innerWidth / 2 ? "left" : "right",
      verticalRatio: Math.max(0, Math.min(1, verticalRatio)),
    }),
  );
}

function miniActionLayout(position: { x: number; y: number } | null) {
  const fallbackX = typeof window === "undefined" ? 9999 : window.innerWidth - 104;
  const fallbackY = typeof window === "undefined" ? 9999 : window.innerHeight - 168;
  const centerX = (position?.x ?? fallbackX) + 46;
  const centerY = (position?.y ?? fallbackY) + 46;
  const horizontalToLeft = typeof window === "undefined" ? true : centerX > window.innerWidth / 2;
  const verticalToTop = typeof window === "undefined" ? true : centerY > window.innerHeight / 2;
  return {
    compactClass: horizontalToLeft
      ? "left-0 top-1/2 -translate-x-[calc(100%+10px)] -translate-y-1/2"
      : "right-0 top-1/2 translate-x-[calc(100%+10px)] -translate-y-1/2",
    fullClass: verticalToTop
      ? "left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(100%+10px)]"
      : "bottom-0 left-1/2 -translate-x-1/2 translate-y-[calc(100%+10px)]",
  };
}

function SeekBar({
  currentTime,
  duration,
  progress,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  progress: number;
  onSeek: (seconds: number) => void;
}) {
  const clampedProgress = Math.max(0, Math.min(100, progress));
  return (
    <div className="relative h-5">
      <div className="absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-white/45 shadow-inner dark:bg-white/10">
        <div
          className="h-full rounded-full bg-primary shadow-[0_0_14px_hsl(var(--primary)/0.32)] transition-[width] duration-200"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
      <div
        className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card bg-primary shadow-lg shadow-primary/30 transition-[left] duration-200"
        style={{ left: `${clampedProgress}%` }}
      />
      <input
        className="player-scrub absolute inset-0 h-5 w-full cursor-pointer"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(currentTime, duration || currentTime)}
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
        aria-label="Seek"
      />
    </div>
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

function InlineLyricsPreview({
  parsed,
  activeIndex,
  rows,
  onOpen,
}: {
  parsed: ParsedLyrics;
  activeIndex: number;
  rows: number;
  onOpen: () => void;
}) {
  const visibleRows = Math.max(1, rows);
  const activeOffset = Math.floor(visibleRows / 2);
  const firstVisibleIndex = Math.max(0, Math.min(activeIndex - activeOffset, Math.max(0, parsed.lines.length - visibleRows)));
  return (
    <button
      className="mx-auto w-full max-w-[min(86vw,340px)] overflow-hidden rounded-xl bg-background/45 px-4 text-center shadow-inner lg:max-w-[282px]"
      style={{ height: visibleRows * LYRIC_PREVIEW_ROW_HEIGHT }}
      onClick={onOpen}
      data-player-no-drag
      aria-label="Open lyrics"
    >
      <div
        className="will-change-transform transition-transform duration-500 ease-out"
        style={{ transform: `translateY(${-firstVisibleIndex * LYRIC_PREVIEW_ROW_HEIGHT}px)` }}
      >
        {parsed.lines.map((line, index) => {
          const visible = index >= firstVisibleIndex && index < firstVisibleIndex + visibleRows;
          return (
            <div
              key={`${line.time}:${index}`}
              data-lyric-index={index}
              className={`lyric-preview-line flex h-7 items-center justify-center truncate transition-[color,opacity,font-size] duration-300 ${
                index === activeIndex
                  ? "text-sm font-semibold text-primary opacity-100"
                  : visible
                    ? "text-xs text-muted-foreground opacity-70"
                    : "text-xs text-muted-foreground opacity-0"
              }`}
            >
              {line.text || " "}
            </div>
          );
        })}
      </div>
    </button>
  );
}

function LyricsPreviewState({
  hasLyrics,
  loading,
  error,
  onOpen,
}: {
  hasLyrics: boolean;
  loading: boolean;
  error: string;
  onOpen: () => void;
}) {
  const label = loading
    ? "Loading lyrics"
    : error
      ? "Lyrics unavailable"
      : hasLyrics
        ? "Lyrics available"
        : "No synced lyrics";
  const detail = hasLyrics ? "Open lyrics" : "No match for this track";

  return (
    <button
      className="mx-auto flex h-14 w-full max-w-[min(86vw,340px)] items-center justify-center gap-2 rounded-xl border border-dashed border-muted-foreground/20 bg-background/30 px-4 text-center text-muted-foreground transition-colors hover:border-muted-foreground/35 hover:bg-muted/40 disabled:hover:border-muted-foreground/20 disabled:hover:bg-background/30 lg:max-w-[282px]"
      onClick={onOpen}
      disabled={!hasLyrics}
      data-player-no-drag
      aria-label={label}
    >
      <Captions className="h-4 w-4 shrink-0 opacity-70" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-xs font-medium text-foreground/70">{label}</span>
        <span className="block truncate text-[11px]">{detail}</span>
      </span>
    </button>
  );
}

function LyricsPanel({
  title,
  text,
  parsed,
  activeIndex,
  choices,
  activeLocationId,
  automatic,
  onChoiceChange,
}: {
  title: string;
  text: string;
  parsed: ParsedLyrics;
  activeIndex: number;
  choices: { mediaItemId: number; locationId: number; title: string; path: string; reason: string }[];
  activeLocationId: number;
  automatic: boolean;
  onChoiceChange: (locationId: number | null) => void;
}) {
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex]);

  if (!parsed.timed) {
    return (
      <div className="space-y-3 p-3">
        <LyricsSourceSelector
          title={title}
          choices={choices}
          activeLocationId={activeLocationId}
          automatic={automatic}
          onChoiceChange={onChoiceChange}
        />
        <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</pre>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      <LyricsSourceSelector
        title={title}
        choices={choices}
        activeLocationId={activeLocationId}
        automatic={automatic}
        onChoiceChange={onChoiceChange}
      />
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
    <div
      className={`${className} grid shrink-0 place-items-center rounded-md bg-secondary text-sm font-bold text-secondary-foreground`}
    >
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

function LyricsSourceSelector({
  title,
  choices,
  activeLocationId,
  automatic,
  onChoiceChange,
}: {
  title: string;
  choices: { mediaItemId: number; locationId: number; title: string; path: string; reason: string }[];
  activeLocationId: number;
  automatic: boolean;
  onChoiceChange: (locationId: number | null) => void;
}) {
  if (choices.length <= 1 && automatic)
    return <div className="truncate text-xs font-semibold text-muted-foreground">{title}</div>;
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0 font-semibold">Lyrics</span>
      <select
        className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1"
        value={automatic ? "auto" : String(activeLocationId)}
        onChange={(event) => onChoiceChange(event.target.value === "auto" ? null : Number(event.target.value))}
      >
        <option value="auto">Auto</option>
        {choices.map((choice) => (
          <option key={choice.locationId} value={choice.locationId}>
            {choice.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatSleepRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  if (seconds < 60) return "<1m";
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}` : `${minutes}m`;
}

function validSleepMinutes(value: string) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
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

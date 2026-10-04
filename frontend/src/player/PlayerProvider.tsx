import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/auth/AuthProvider";
import { currentClientStorageScope, currentScopedStorageKey } from "@/lib/clientStorageScope";

import { audioElementEventProps } from "./audioElementEvents";
import type { LyricsChoice } from "./lyricsMatching";
import { nextAutoAdvanceIndex } from "./nextTrackPreload";
import {
  OBSOLETE_PLAYER_PROGRESS_STORAGE_BASE_KEY,
  PLAYBACK_COMPATIBILITY_STORAGE_BASE_KEY,
  PLAYER_QUEUE_STORAGE_BASE_KEY,
} from "./playerPersistence";
import type { PlayerRemoteControls } from "./playerRemoteControls";
import { supportsCompatibilityPlayback } from "./playerTrackMedia";
import type {
  LyricsPreferenceTarget,
  PlaybackCompatibilityScope,
  PlayerTrack,
  PlayMode,
  SleepTimerState,
} from "./playerTypes";
import { usePlaybackCompatibility } from "./usePlaybackCompatibility";
import { usePlaybackEngine } from "./usePlaybackEngine";
import { usePlaybackProgress } from "./usePlaybackProgress";
import { usePlaybackRecovery } from "./usePlaybackRecovery";
import { usePlaybackSourcePreferences } from "./usePlaybackSourcePreferences";
import { usePlaybackSource } from "./usePlaybackSource";
import { usePlayerKeyboardShortcuts } from "./usePlayerKeyboardShortcuts";
import { usePlayerQueueActions } from "./usePlayerQueueActions";
import { usePersistPlayerQueue, useRestoredPlayerQueue, useRestoredQueueRevalidation } from "./usePlayerQueueStorage";
import { usePlaybackSeekPreferences, usePlayerSeeking } from "./usePlayerSeeking";
import { useListeningSessionRecorder } from "./useListeningSessionRecorder";
import { useRemoteStreamCaching } from "./useRemoteStreamCaching";
import { useSleepRewindPreference, useSleepTimer } from "./useSleepTimer";
import { useBrowserMediaSession, useNativeMediaBridge } from "./useSystemMediaControls";

export { lyricsPreferenceKey, preferredLyricsMediaItemID } from "./lyricsPreference";
export type {
  DockMode,
  LyricsPreferenceTarget,
  PlaybackCompatibilityScope,
  PlayerTrack,
  PlayerTrackLocation,
  PlayMode,
  SleepTimerState,
} from "./playerTypes";

type PlayerContextValue = {
  queue: PlayerTrack[];
  currentIndex: number;
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  isBuffering: boolean;
  duration: number;
  playbackRate: number;
  sleepTimer: SleepTimerState;
  mode: PlayMode;
  playQueue: (tracks: PlayerTrack[], locationId: number, startPositionSeconds?: number) => void;
  selectTrack: (index: number) => void;
  togglePlay: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seekBy: (seconds: number) => void;
  seekTo: (seconds: number) => void;
  seekBackward: () => void;
  seekForward: () => void;
  seekBackwardSeconds: number;
  seekForwardSeconds: number;
  cyclePlaybackRate: () => void;
  setPlaybackRate: (rate: number) => void;
  playbackCompatibilityScope: PlaybackCompatibilityScope;
  compatibilityPlaybackEnabled: boolean;
  setPlaybackCompatibility: (scope: PlaybackCompatibilityScope, resume?: boolean) => void;
  playNext: (track: PlayerTrack) => void;
  appendQueue: (tracks: PlayerTrack[]) => void;
  moveQueueItem: (queueItemId: string, direction: -1 | 1) => void;
  moveQueueItemTo: (queueItemId: string, targetIndex: number) => void;
  removeQueueItem: (queueItemId: string) => void;
  clearQueue: () => void;
  selectLocation: (locationId: number) => void;
  /** Whether this account lets the Now Playing source label switch locations. */
  sourceSwitchingEnabled: boolean;
  setSleepTimerMinutes: (minutes: number, finishCurrentTrack: boolean) => void;
  setSleepFinishCurrentTrack: (enabled: boolean) => void;
  clearSleepTimer: () => void;
  /** Minutes to rewind within the current track when the sleep timer stops playback. */
  sleepRewindMinutes: number;
  setSleepRewindMinutes: (minutes: number) => void;
  cycleMode: () => void;
  setMode: (mode: PlayMode) => void;
  lyricsPreferenceOverrides: Record<string, number | null>;
  changeLyricsChoice: (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => Promise<void>;
};

const PlayerContext = createContext<PlayerContextValue | null>(null);

// The playback clock changes several times a second while audio plays. It has
// its own context so components that only need controls or track state do not
// re-render on every time update; read it from the smallest leaf that shows it.
type PlayerTimeContextValue = {
  currentTime: number;
  sleepRemainingSeconds: number;
};

const PlayerTimeContext = createContext<PlayerTimeContextValue | null>(null);
type LibraryPlayerContextValue = {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  currentLocationId: number | null;
  currentPlaybackKey: string | null;
  playQueue: (tracks: PlayerTrack[], locationId: number, startPositionSeconds?: number) => void;
  playNext: (track: PlayerTrack) => void;
  appendQueue: (tracks: PlayerTrack[]) => void;
  lyricsPreferenceOverrides: Record<string, number | null>;
  changeLyricsChoice: (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => Promise<void>;
};

const LibraryPlayerContext = createContext<LibraryPlayerContextValue | null>(null);

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const principalID = auth.user?.id ?? null;
  const playerQueueStorageKey = currentScopedStorageKey(PLAYER_QUEUE_STORAGE_BASE_KEY, principalID);
  const obsoletePlayerProgressStorageKey = currentScopedStorageKey(
    OBSOLETE_PLAYER_PROGRESS_STORAGE_BASE_KEY,
    principalID,
  );
  const playbackCompatibilityStorageKey = currentScopedStorageKey(PLAYBACK_COMPATIBILITY_STORAGE_BASE_KEY, principalID);

  const restoredQueue = useRestoredPlayerQueue(playerQueueStorageKey, obsoletePlayerProgressStorageKey);
  const [queue, setQueue] = useState<PlayerTrack[]>(restoredQueue.queue);
  const [currentIndex, setCurrentIndex] = useState(restoredQueue.currentIndex);
  const [playbackRate, setPlaybackRateState] = useState(restoredQueue.playbackRate);
  const [mode, setMode] = useState<PlayMode>(restoredQueue.mode);
  const seekPreferences = usePlaybackSeekPreferences(principalID);
  const sourcePreferences = usePlaybackSourcePreferences(principalID);

  const engine = usePlaybackEngine(queue, currentIndex);
  const {
    refs,
    currentTrack,
    currentPlaybackKey,
    isPlaying,
    isBuffering,
    currentTime,
    duration,
    durationLocationId,
    updatePlayingState,
  } = engine;
  const {
    playbackCompatibilityScope,
    compatibilityPlaybackEnabled,
    queueWideCompatibilityEnabled,
    setPlaybackCompatibility,
    resetTransientPlaybackCompatibility,
  } = usePlaybackCompatibility(playbackCompatibilityStorageKey, engine);
  const { saveProgress, flushProgress, checkpointProgress } = usePlaybackProgress(
    engine,
    Boolean(auth.user) && !auth.demoMode,
    principalID,
  );
  const { sleepRewindMinutes, setSleepRewindMinutes } = useSleepRewindPreference(principalID);
  const {
    sleepTimer,
    sleepRemainingSeconds,
    setSleepTimerMinutes,
    setSleepFinishCurrentTrack,
    clearSleepTimer,
    stopForSleepTimer,
  } = useSleepTimer({
    initialSleepTimer: restoredQueue.sleepTimer,
    engine,
    rewindMinutes: sleepRewindMinutes,
    checkpointProgress,
  });
  // Listening history belongs to a signed-in principal with playback permission.
  const listeningScope =
    auth.user && !auth.demoMode && auth.hasPermission("playback:use") ? currentClientStorageScope(auth.user.id) : null;
  useListeningSessionRecorder(refs.audioRef, listeningScope, currentTrack);
  useRestoredQueueRevalidation(restoredQueue, engine, setQueue, setCurrentIndex);
  usePersistPlayerQueue({
    storageKey: playerQueueStorageKey,
    queue,
    currentIndex,
    mode,
    playbackRate,
    sleepTimer,
  });

  const nextTrackIndex = nextAutoAdvanceIndex(currentIndex, queue.length, mode);
  const nextTrack = nextTrackIndex === null || sleepTimer?.waitingForTrackEnd ? null : (queue[nextTrackIndex] ?? null);
  usePlaybackSource(engine, {
    compatibilityPlaybackEnabled,
    playbackRate,
    nextTrack,
    nextTrackCompatibility: supportsCompatibilityPlayback(nextTrack) && queueWideCompatibilityEnabled,
  });
  useRemoteStreamCaching(currentTrack, auth.demoMode);
  const { handlePlaybackError, resetLocationFailures } = usePlaybackRecovery(engine, {
    setQueue,
    flushProgress,
    sourceFallback: sourcePreferences.sourceFallback,
    setPlaybackCompatibility,
  });
  const { seekTo, seekBy, seekBackward, seekForward } = usePlayerSeeking(engine, seekPreferences);
  const {
    lyricsPreferenceOverrides,
    changeLyricsChoice,
    playQueue,
    selectTrack,
    next,
    previous,
    playNext,
    appendQueue,
    moveQueueItemTo,
    moveQueueItem,
    removeQueueItem,
    clearQueue,
    selectLocation,
  } = usePlayerQueueActions({
    engine,
    queue,
    setQueue,
    currentIndex,
    setCurrentIndex,
    mode,
    flushProgress,
    resetLocationFailures,
    resetTransientPlaybackCompatibility,
    clearSleepTimer,
  });

  const hasTrack = currentTrack !== null;
  const play = useCallback(
    () => updatePlayingState((value) => (hasTrack ? true : value)),
    [hasTrack, updatePlayingState],
  );
  const pause = useCallback(() => updatePlayingState(false), [updatePlayingState]);
  const togglePlay = useCallback(
    () => updatePlayingState((value) => (hasTrack ? !value : false)),
    [hasTrack, updatePlayingState],
  );
  const cyclePlaybackRate = useCallback(
    () => setPlaybackRateState((value) => PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(value) + 1) % PLAYBACK_RATES.length]),
    [],
  );
  const setPlaybackRate = useCallback((rate: number) => {
    if (PLAYBACK_RATES.includes(rate)) setPlaybackRateState(rate);
  }, []);
  const cycleMode = useCallback(
    () => setMode((value) => (value === "order" ? "loop" : value === "loop" ? "single" : "order")),
    [],
  );

  // System controls are registered once and resolve the latest controls when an action arrives.
  const remoteControls: PlayerRemoteControls = { play, pause, previous, next, seekBackward, seekForward, seekTo };
  const remoteControlsRef = useRef(remoteControls);
  useEffect(() => {
    remoteControlsRef.current = remoteControls;
  });
  useNativeMediaBridge({
    refs,
    controlsRef: remoteControlsRef,
    currentTrack,
    isPlaying,
    duration,
    durationLocationId,
    playbackRate,
    canPrevious: currentIndex > 0 || mode === "loop",
    canNext: currentIndex < queue.length - 1 || mode === "loop",
    seekPreferences,
  });
  useBrowserMediaSession({
    controlsRef: remoteControlsRef,
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
  });
  usePlayerKeyboardShortcuts({ hasTrack, togglePlay, seekBackward, seekForward });

  const audioEvents = audioElementEventProps(engine, {
    queueLength: queue.length,
    currentIndex,
    setCurrentIndex,
    mode,
    sleepTimer,
    stopForSleepTimer,
    saveProgress,
    onError: handlePlaybackError,
  });

  const { seekBackwardSeconds, seekForwardSeconds } = seekPreferences;
  const sourceSwitchingEnabled = sourcePreferences.sourceSwitching;
  const value = useMemo<PlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      isBuffering,
      duration,
      playbackRate,
      sleepTimer,
      mode,
      playbackCompatibilityScope,
      compatibilityPlaybackEnabled,
      setPlaybackCompatibility,
      playQueue,
      selectTrack,
      togglePlay,
      pause,
      next,
      previous,
      seekBy,
      seekTo,
      seekBackward,
      seekForward,
      seekBackwardSeconds,
      seekForwardSeconds,
      cyclePlaybackRate,
      setPlaybackRate,
      playNext,
      appendQueue,
      moveQueueItem,
      moveQueueItemTo,
      removeQueueItem,
      clearQueue,
      selectLocation,
      sourceSwitchingEnabled,
      setSleepTimerMinutes,
      setSleepFinishCurrentTrack,
      clearSleepTimer,
      sleepRewindMinutes,
      setSleepRewindMinutes,
      cycleMode,
      setMode,
      lyricsPreferenceOverrides,
      changeLyricsChoice,
    }),
    [
      queue,
      currentIndex,
      currentTrack,
      isPlaying,
      isBuffering,
      duration,
      playbackRate,
      sleepTimer,
      mode,
      playbackCompatibilityScope,
      compatibilityPlaybackEnabled,
      setPlaybackCompatibility,
      playQueue,
      selectTrack,
      togglePlay,
      pause,
      next,
      previous,
      seekBy,
      seekTo,
      seekBackward,
      seekForward,
      seekBackwardSeconds,
      seekForwardSeconds,
      cyclePlaybackRate,
      setPlaybackRate,
      playNext,
      appendQueue,
      moveQueueItem,
      moveQueueItemTo,
      removeQueueItem,
      clearQueue,
      selectLocation,
      sourceSwitchingEnabled,
      setSleepTimerMinutes,
      setSleepFinishCurrentTrack,
      clearSleepTimer,
      sleepRewindMinutes,
      setSleepRewindMinutes,
      cycleMode,
      lyricsPreferenceOverrides,
      changeLyricsChoice,
    ],
  );
  const timeValue = useMemo<PlayerTimeContextValue>(
    () => ({ currentTime, sleepRemainingSeconds }),
    [currentTime, sleepRemainingSeconds],
  );
  const libraryValue = useMemo<LibraryPlayerContextValue>(
    () => ({
      currentTrack,
      isPlaying,
      currentLocationId: currentTrack?.locationId ?? null,
      currentPlaybackKey,
      playQueue,
      playNext,
      appendQueue,
      lyricsPreferenceOverrides,
      changeLyricsChoice,
    }),
    [
      currentPlaybackKey,
      currentTrack,
      isPlaying,
      playQueue,
      playNext,
      appendQueue,
      lyricsPreferenceOverrides,
      changeLyricsChoice,
    ],
  );

  return (
    <LibraryPlayerContext.Provider value={libraryValue}>
      <PlayerContext.Provider value={value}>
        <PlayerTimeContext.Provider value={timeValue}>{children}</PlayerTimeContext.Provider>
        <audio ref={refs.audioRef} preload="metadata" {...audioEvents} />
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

/** The playback clock; changes several times a second while audio plays. */
export function usePlayerTime() {
  const value = useContext(PlayerTimeContext);
  if (!value) {
    throw new Error("usePlayerTime must be used inside PlayerProvider");
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

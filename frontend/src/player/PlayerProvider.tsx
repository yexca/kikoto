import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { bufferedEndAt, nextAutoAdvanceIndex, shouldPreloadNextTrack } from "./nextTrackPreload";
import { withQueueIdentity } from "./playbackIdentity";
import {
  discardObsoletePlayerState,
  loadPersistedPlaybackCompatibility,
  loadPersistedQueue,
  OBSOLETE_PLAYER_PROGRESS_STORAGE_BASE_KEY,
  PLAYBACK_COMPATIBILITY_STORAGE_BASE_KEY,
  PLAYER_QUEUE_STORAGE_BASE_KEY,
} from "./playerPersistence";
import { moveQueueItemToIndex } from "./queueOrder";
import { useNextTrackPreload } from "./useNextTrackPreload";
import type {
  LyricsPreferenceTarget,
  PlaybackCompatibilityScope,
  PlayerTrack,
  PlayMode,
  SleepTimerState,
} from "./playerTypes";
export type {
  DockMode,
  LyricsPreferenceTarget,
  PlaybackCompatibilityScope,
  PlayerTrack,
  PlayerTrackLocation,
  PlayMode,
  SleepTimerState,
} from "./playerTypes";

import { PLAYBACK_CURSOR_UPDATED_EVENT } from "@/app/events";
import { useAuth } from "@/auth/AuthProvider";
import { useToast } from "@/components/ui/toast";
import { api, ApiError, assetURL } from "@/lib/api";
import { currentScopedStorageKey } from "@/lib/clientStorageScope";
import { addNativeMediaListeners, stopNativeMedia, supportsNativeMedia, updateNativeMedia } from "@/lib/nativeMedia";
import { type LyricsChoice } from "@/player/lyricsMatching";
import { playbackURL, remoteMediaPlaybackURL } from "@/player/mediaPlayback";
import { playbackKeyForLocation, remotePlaybackKey } from "@/player/playbackIdentity";
import {
  getStoredPlaybackSeekPreferences,
  playbackSeekPreferencesStorageKey,
  PLAYER_SEEK_PREFERENCES_CHANGE_EVENT,
  type PlaybackSeekPreferences,
  type PlaybackSeekPreferencesChangeDetail,
} from "@/player/playbackPreferences";
import { isActivePlaybackRequest } from "@/player/playbackRequest";
import {
  canPersistPlaybackProgress,
  normalizePlaybackStartPosition,
  restoredCursorStartPosition,
  shouldCheckpointPause,
} from "@/player/playbackStart";
import {
  NATIVE_MEDIA_POSITION_INTERVAL_MS,
  shouldCommitPlayerTime,
  shouldSaveRemoteProgress,
  type ProgressSaveMarker,
} from "@/player/playerProgress";
import { revalidatePersistedQueue } from "@/player/playerQueueRestore";
import {
  applyTrackLocation,
  createTrackLocationFailureState,
  orderedTrackLocations,
  recordTrackLocationFailure,
  resetTrackLocationFailures,
} from "@/player/trackLocations";
type ProgressSavePayload = {
  locationId: number;
  positionSeconds: number;
  durationSeconds: number | null;
  completed: boolean;
};
type PendingPlaybackStart = {
  queueItemId: string;
  positionSeconds: number;
};

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
  setSleepTimerMinutes: (minutes: number, finishCurrentTrack: boolean) => void;
  setSleepFinishCurrentTrack: (enabled: boolean) => void;
  clearSleepTimer: () => void;
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

function createPlaybackSessionID() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isExpectedPlaybackInterruption(error: unknown) {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return error.name === "AbortError" || error.name === "NotAllowedError";
}

export function lyricsPreferenceKey(target: LyricsPreferenceTarget) {
  return target.mediaItemId > 0 ? `media:${target.mediaItemId}` : `preview:${target.playbackKey ?? target.mediaItemId}`;
}

export function preferredLyricsMediaItemID(target: LyricsPreferenceTarget, overrides: Record<string, number | null>) {
  const key = lyricsPreferenceKey(target);
  return Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : (target.preferredLyricsMediaItemId ?? null);
}

function applyLyricsChoiceToTrack(track: PlayerTrack, target: LyricsPreferenceTarget, choice: LyricsChoice | null) {
  const choices = target.lyricsChoices ?? track.lyricsChoices ?? [];
  const autoLocationID = target.autoLyricsLocationId ?? track.autoLyricsLocationId ?? null;
  const activeChoice = choice ?? choices.find((candidate) => candidate.locationId === autoLocationID) ?? null;
  return {
    ...track,
    lyricsChoices: choices,
    autoLyricsLocationId: autoLocationID,
    preferredLyricsMediaItemId: choice?.mediaItemId ?? null,
    lyricsLocationId: activeChoice?.locationId ?? null,
    lyricsTitle: activeChoice?.title ?? "",
  };
}

function applyLyricsPreferenceOverride(track: PlayerTrack, overrides: Record<string, number | null>) {
  const preferenceKey = lyricsPreferenceKey(track);
  if (!Object.prototype.hasOwnProperty.call(overrides, preferenceKey)) return track;
  const preferredMediaItemID = overrides[preferenceKey];
  if (preferredMediaItemID === null) return applyLyricsChoiceToTrack(track, track, null);
  const choice = track.lyricsChoices?.find((candidate) => candidate.mediaItemId === preferredMediaItemID);
  return choice
    ? applyLyricsChoiceToTrack(track, track, choice)
    : { ...track, preferredLyricsMediaItemId: preferredMediaItemID };
}

async function saveProgressWithBusyRetry(mediaItemId: number, payload: ProgressSavePayload) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const cursor = await api.updateMediaProgress(mediaItemId, payload);
      window.dispatchEvent(new CustomEvent(PLAYBACK_CURSOR_UPDATED_EVENT, { detail: cursor }));
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "database_busy" || attempt > 0) return;
      await new Promise((resolve) => window.setTimeout(resolve, 200 + Math.round(Math.random() * 200)));
    }
  }
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const { t } = useTranslation();
  const principalID = auth.user?.id ?? null;
  const playerQueueStorageKey = currentScopedStorageKey(PLAYER_QUEUE_STORAGE_BASE_KEY, principalID);
  const obsoletePlayerProgressStorageKey = currentScopedStorageKey(
    OBSOLETE_PLAYER_PROGRESS_STORAGE_BASE_KEY,
    principalID,
  );
  const playbackCompatibilityStorageKey = currentScopedStorageKey(PLAYBACK_COMPATIBILITY_STORAGE_BASE_KEY, principalID);
  const seekPreferencesStorageKey = playbackSeekPreferencesStorageKey(principalID);
  const toast = useToast();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const restoredQueueRef = useRef<ReturnType<typeof loadPersistedQueue> | null>(null);
  if (restoredQueueRef.current === null) {
    discardObsoletePlayerState(obsoletePlayerProgressStorageKey);
    restoredQueueRef.current = loadPersistedQueue(playerQueueStorageKey);
  }
  const restoredQueue = restoredQueueRef.current;
  const [queue, setQueue] = useState<PlayerTrack[]>(restoredQueue.queue);
  const [currentIndex, setCurrentIndex] = useState(restoredQueue.currentIndex);
  const [lyricsPreferenceOverrides, setLyricsPreferenceOverrides] = useState<Record<string, number | null>>({});
  const lyricsPreferenceOverridesRef = useRef(lyricsPreferenceOverrides);
  lyricsPreferenceOverridesRef.current = lyricsPreferenceOverrides;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [playbackReloadToken, setPlaybackReloadToken] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [durationLocationId, setDurationLocationId] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState(restoredQueue.playbackRate);
  const [mode, setMode] = useState<PlayMode>(restoredQueue.mode);
  const [seekPreferences, setSeekPreferences] = useState<PlaybackSeekPreferences>(() =>
    getStoredPlaybackSeekPreferences(principalID),
  );
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(restoredQueue.sleepTimer);
  const [sleepRemainingSeconds, setSleepRemainingSeconds] = useState(0);
  const [playbackCompatibilityScope, setPlaybackCompatibilityScopeState] = useState<PlaybackCompatibilityScope>(() =>
    loadPersistedPlaybackCompatibility(playbackCompatibilityStorageKey),
  );
  const [playbackCompatibilityTarget, setPlaybackCompatibilityTarget] = useState<string | null>(null);
  const [playbackCompatibilityLoadedKey, setPlaybackCompatibilityLoadedKey] = useState(playbackCompatibilityStorageKey);
  const queueRef = useRef(queue);
  const currentIndexRef = useRef(currentIndex);
  const isPlayingRef = useRef(isPlaying);
  const playbackGenerationRef = useRef(0);
  const currentPlaybackInstanceKeyRef = useRef<string | null>(null);
  const sourceLoadingRef = useRef(false);
  const restoredMediaItemRef = useRef<string | null>(null);
  const pendingPlaybackStartRef = useRef<PendingPlaybackStart | null>(null);
  const unappliedStartRef = useRef<{ instanceKey: string; positionSeconds: number } | null>(null);
  const listenerIntentInstanceRef = useRef<string | null>(null);
  const [startPositionRequest, setStartPositionRequest] = useState(0);
  const completedPlaybackInstanceRef = useRef<string | null>(null);
  const lastSavedRef = useRef<ProgressSaveMarker | null>(null);
  const lastPlayerTimeCommitRef = useRef<number | null>(null);
  const pendingSeekTargetRef = useRef<number | null>(null);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const progressSaveRef = useRef<(completed: boolean, force?: boolean) => void>(() => {});
  const progressSaveQueueRef = useRef<{ inFlight: boolean; pending: Map<number, ProgressSavePayload> }>({
    inFlight: false,
    pending: new Map(),
  });
  const cacheRequestedRef = useRef<Set<string>>(new Set());
  const queueSessionRef = useRef(createPlaybackSessionID());
  const playbackCompatibilityScopeRef = useRef(playbackCompatibilityScope);
  const playbackCompatibilityTargetRef = useRef(playbackCompatibilityTarget);
  const playbackCompatibilityStorageKeyRef = useRef(playbackCompatibilityStorageKey);
  const currentTrackRef = useRef<PlayerTrack | null>(null);
  const playbackErrorSequenceRef = useRef(0);
  const playbackErrorAbortRef = useRef<AbortController | null>(null);
  const playbackErrorHandlerRef = useRef<() => void>(() => {});
  const locationFailureStateRef = useRef(createTrackLocationFailureState());
  const nativeControlRef = useRef({
    play: () => {},
    pause: () => {},
    previous: () => {},
    next: () => {},
    seekBackward: () => {},
    seekForward: () => {},
    seekTo: (_seconds: number) => {},
  });
  const nativeMediaSyncRef = useRef<() => void>(() => {});
  isPlayingRef.current = isPlaying;
  const seekPreferencesRef = useRef(seekPreferences);
  seekPreferencesRef.current = seekPreferences;

  const updatePlayingState = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(isPlayingRef.current) : next;
    if (resolved) {
      playbackErrorAbortRef.current?.abort();
      playbackErrorAbortRef.current = null;
      playbackErrorSequenceRef.current += 1;
    }
    isPlayingRef.current = resolved;
    setIsPlaying(resolved);
  }, []);
  const invalidatePlaybackRequests = useCallback(() => {
    playbackGenerationRef.current += 1;
  }, []);
  const clearPendingSeek = useCallback(() => {
    pendingSeekTargetRef.current = null;
    if (pendingSeekTimerRef.current !== null) window.clearTimeout(pendingSeekTimerRef.current);
    pendingSeekTimerRef.current = null;
  }, []);

  const currentTrack = queue[currentIndex] ?? null;
  const currentPlaybackKey = trackPlaybackKey(currentTrack);
  const currentPlaybackInstanceKey =
    currentTrack && currentPlaybackKey
      ? `${currentTrack.queueItemId ?? ""}:${currentPlaybackKey}:${currentTrack.locationId}:${currentTrack.streamUrl}:${playbackReloadToken}`
      : null;
  queueRef.current = queue;
  currentIndexRef.current = currentIndex;
  currentPlaybackInstanceKeyRef.current = currentPlaybackInstanceKey;
  // A start position still waiting for metadata is the instance's real position.
  const carriedPlaybackPosition = useCallback(() => {
    const unappliedStart = unappliedStartRef.current;
    if (unappliedStart && unappliedStart.instanceKey === currentPlaybackInstanceKeyRef.current) {
      return unappliedStart.positionSeconds;
    }
    return normalizePlaybackStartPosition(audioRef.current?.currentTime);
  }, []);
  currentTrackRef.current = currentTrack;
  playbackCompatibilityScopeRef.current = playbackCompatibilityScope;
  playbackCompatibilityTargetRef.current = playbackCompatibilityTarget;

  const compatibilityTrackKey = currentTrack
    ? (currentTrack.queueItemId ?? `media:${currentTrack.mediaItemId}:${currentTrack.workCode}`)
    : null;
  const compatibilityLocationEligible =
    currentTrack?.locationType === "local" || currentTrack?.locationType === "cache";
  const compatibilityPlaybackEnabled = Boolean(
    compatibilityLocationEligible &&
    playbackCompatibilityLoadedKey === playbackCompatibilityStorageKey &&
    ((playbackCompatibilityScope === "always" && playbackCompatibilityTarget === null) ||
      (playbackCompatibilityScope === "track" && playbackCompatibilityTarget === compatibilityTrackKey) ||
      (playbackCompatibilityScope === "queue" && playbackCompatibilityTarget === queueSessionRef.current)),
  );
  const compatibilityPlaybackEnabledRef = useRef(compatibilityPlaybackEnabled);
  compatibilityPlaybackEnabledRef.current = compatibilityPlaybackEnabled;

  const setPlaybackCompatibility = useCallback(
    (scope: PlaybackCompatibilityScope, resume = false) => {
      const track = currentTrackRef.current;
      if (scope !== "off" && !track) return;
      const target =
        scope === "track"
          ? (track?.queueItemId ?? (track ? `media:${track.mediaItemId}:${track.workCode}` : null))
          : scope === "queue"
            ? queueSessionRef.current
            : null;
      const nextCompatibilityEnabled = Boolean(
        track && (track.locationType === "local" || track.locationType === "cache") && scope !== "off",
      );
      if (nextCompatibilityEnabled !== compatibilityPlaybackEnabledRef.current && track?.queueItemId) {
        pendingPlaybackStartRef.current = {
          queueItemId: track.queueItemId,
          positionSeconds: carriedPlaybackPosition(),
        };
      }
      playbackCompatibilityScopeRef.current = scope;
      playbackCompatibilityTargetRef.current = target;
      setPlaybackCompatibilityScopeState(scope);
      setPlaybackCompatibilityTarget(target);
      playbackErrorAbortRef.current?.abort();
      playbackErrorAbortRef.current = null;
      playbackErrorSequenceRef.current += 1;
      if (resume && track) updatePlayingState(true);
    },
    [carriedPlaybackPosition, updatePlayingState],
  );

  const resetTransientPlaybackCompatibility = useCallback(() => {
    queueSessionRef.current = createPlaybackSessionID();
    if (playbackCompatibilityScopeRef.current === "always") {
      playbackCompatibilityTargetRef.current = null;
      setPlaybackCompatibilityTarget(null);
      return;
    }
    playbackCompatibilityScopeRef.current = "off";
    playbackCompatibilityTargetRef.current = null;
    setPlaybackCompatibilityScopeState("off");
    setPlaybackCompatibilityTarget(null);
  }, []);

  useEffect(() => {
    if (playbackCompatibilityStorageKeyRef.current !== playbackCompatibilityStorageKey) {
      playbackCompatibilityStorageKeyRef.current = playbackCompatibilityStorageKey;
      const restoredScope = loadPersistedPlaybackCompatibility(playbackCompatibilityStorageKey);
      playbackCompatibilityScopeRef.current = restoredScope;
      playbackCompatibilityTargetRef.current = null;
      setPlaybackCompatibilityScopeState(restoredScope);
      setPlaybackCompatibilityTarget(null);
      setPlaybackCompatibilityLoadedKey(playbackCompatibilityStorageKey);
      return;
    }
    try {
      if (playbackCompatibilityScope === "always") {
        localStorage.setItem(playbackCompatibilityStorageKey, JSON.stringify({ version: 1, scope: "always" }));
      } else {
        localStorage.removeItem(playbackCompatibilityStorageKey);
      }
    } catch {
      // Playback remains usable when browser storage is unavailable.
    }
  }, [playbackCompatibilityLoadedKey, playbackCompatibilityScope, playbackCompatibilityStorageKey]);

  useEffect(() => {
    if (playbackCompatibilityScope !== "track" || playbackCompatibilityTarget === compatibilityTrackKey) return;
    playbackCompatibilityScopeRef.current = "off";
    playbackCompatibilityTargetRef.current = null;
    setPlaybackCompatibilityScopeState("off");
    setPlaybackCompatibilityTarget(null);
  }, [compatibilityTrackKey, playbackCompatibilityScope, playbackCompatibilityTarget]);

  const requestAudioPlay = useCallback(
    (audio: HTMLAudioElement, playbackKey: string | null) => {
      const generation = playbackGenerationRef.current + 1;
      playbackGenerationRef.current = generation;
      const request = { generation, playbackKey };
      const handleFailure = (error: unknown) => {
        if (
          !isActivePlaybackRequest(
            request,
            playbackGenerationRef.current,
            currentPlaybackInstanceKeyRef.current,
            isPlayingRef.current,
          )
        )
          return;
        sourceLoadingRef.current = false;
        setIsBuffering(false);
        updatePlayingState(false);
        if (!isExpectedPlaybackInterruption(error)) playbackErrorHandlerRef.current();
      };
      let result: Promise<void> | void;
      try {
        result = audio.play();
      } catch (error) {
        handleFailure(error);
        return;
      }
      void Promise.resolve(result).then(() => {
        if (
          isActivePlaybackRequest(
            request,
            playbackGenerationRef.current,
            currentPlaybackInstanceKeyRef.current,
            isPlayingRef.current,
          )
        )
          sourceLoadingRef.current = false;
      }, handleFailure);
    },
    [updatePlayingState],
  );

  useEffect(() => {
    discardObsoletePlayerState(obsoletePlayerProgressStorageKey);
  }, [obsoletePlayerProgressStorageKey]);

  useEffect(() => {
    setSeekPreferences(getStoredPlaybackSeekPreferences(principalID));
    const syncCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<PlaybackSeekPreferencesChangeDetail>).detail;
      if (!detail || detail.storageKey !== seekPreferencesStorageKey) return;
      setSeekPreferences(detail.preferences);
    };
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key !== seekPreferencesStorageKey) return;
      setSeekPreferences(getStoredPlaybackSeekPreferences(principalID));
    };
    window.addEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(PLAYER_SEEK_PREFERENCES_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, [principalID, seekPreferencesStorageKey]);

  useEffect(() => {
    const restored = restoredQueue.queue;
    if (restored.length === 0) return;
    let cancelled = false;
    void revalidatePersistedQueue(
      restored,
      async (workID) => (await api.getWorkMedia(workID)).mediaItems,
      async (workID) => {
        const work = await api.getWorkSummary(workID);
        return {
          primaryCode: work.primaryCode,
          title: work.title,
          coverUrl: work.coverUrl,
          circle: work.circle,
        };
      },
    ).then((validated) => {
      if (cancelled) return;
      const current = queueRef.current;
      if (
        current.length !== restored.length ||
        current.some((track, index) => track.queueItemId !== restored[index]?.queueItemId)
      )
        return;
      const currentQueueItemID = current[currentIndexRef.current]?.queueItemId;
      const validatedIndex = Math.max(
        0,
        validated.findIndex((track) => track.queueItemId === currentQueueItemID),
      );
      // The restored session item continues its Resume cursor until the listener acts on it.
      const cursorPosition = restoredCursorStartPosition(validated[validatedIndex]?.progress);
      if (
        cursorPosition > 0 &&
        currentQueueItemID &&
        currentQueueItemID === restored[restoredQueue.currentIndex]?.queueItemId &&
        listenerIntentInstanceRef.current !== currentPlaybackInstanceKeyRef.current
      ) {
        pendingPlaybackStartRef.current = { queueItemId: currentQueueItemID, positionSeconds: cursorPosition };
        restoredMediaItemRef.current = null;
        setStartPositionRequest((value) => value + 1);
      }
      invalidatePlaybackRequests();
      setQueue(validated);
      setCurrentIndex(validatedIndex);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
    const persistentQueue = queue
      .filter((track) => track.mediaItemId > 0 && track.progressRecordable)
      .map((track) => ({ ...track, progress: null }));
    const currentQueueItemId = queue[currentIndex]?.queueItemId ?? "";
    const persistedCurrentIndex = Math.max(
      0,
      persistentQueue.findIndex((track) => track.queueItemId === currentQueueItemId),
    );
    try {
      localStorage.setItem(
        playerQueueStorageKey,
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
    } catch {
      // Playback should continue when browser storage is unavailable or full.
    }
  }, [queue, currentIndex, mode, playbackRate, playerQueueStorageKey, sleepTimer]);

  useEffect(() => {
    resetTrackLocationFailures(locationFailureStateRef.current);
  }, [currentTrack?.queueItemId, currentTrack?.mediaItemId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    invalidatePlaybackRequests();
    playbackErrorAbortRef.current?.abort();
    playbackErrorAbortRef.current = null;
    playbackErrorSequenceRef.current += 1;
    clearPendingSeek();
    if (!currentTrack) {
      sourceLoadingRef.current = false;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      setCurrentTime(0);
      setDuration(0);
      setDurationLocationId(null);
      return;
    }
    sourceLoadingRef.current = true;
    audio.pause();
    audio.src = assetURL(playerTrackAudioURL(currentTrack, compatibilityPlaybackEnabled));
    audio.load();
    lastPlayerTimeCommitRef.current = null;
    setCurrentTime(0);
    setDuration(0);
    setDurationLocationId(currentTrack.locationId);
    restoredMediaItemRef.current = null;
  }, [
    compatibilityPlaybackEnabled,
    currentPlaybackInstanceKey,
    currentTrack?.locationId,
    currentTrack?.streamUrl,
    clearPendingSeek,
    invalidatePlaybackRequests,
  ]);

  useEffect(() => {
    if (auth.demoMode || !currentTrack || currentTrack.locationType !== "remote_stream") return;
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
    currentPlaybackKey,
    currentTrack?.locationId,
    currentTrack?.locationType,
    currentTrack?.remoteSourceId,
    currentTrack?.remoteWorkCode,
    currentTrack?.remotePath,
    auth.demoMode,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (
      !audio ||
      !currentTrack ||
      !currentPlaybackInstanceKey ||
      restoredMediaItemRef.current === currentPlaybackInstanceKey
    )
      return;
    const pendingStart = pendingPlaybackStartRef.current;
    const pendingStartMatches = pendingStart !== null && pendingStart.queueItemId === currentTrack.queueItemId;
    const unappliedStart = unappliedStartRef.current;
    const position = pendingStartMatches
      ? pendingStart.positionSeconds
      : unappliedStart?.instanceKey === currentPlaybackInstanceKey
        ? unappliedStart.positionSeconds
        : 0;
    if (pendingStartMatches) {
      pendingPlaybackStartRef.current = null;
    }
    if (position > 0 && Number.isFinite(position)) {
      unappliedStartRef.current = { instanceKey: currentPlaybackInstanceKey, positionSeconds: position };
      const restore = () => {
        audio.currentTime = Math.min(position, audio.duration || position);
        setCurrentTime(audio.currentTime);
        unappliedStartRef.current = null;
        restoredMediaItemRef.current = currentPlaybackInstanceKey;
      };
      if (audio.readyState >= 1) {
        restore();
      } else {
        audio.addEventListener("loadedmetadata", restore, { once: true });
        return () => audio.removeEventListener("loadedmetadata", restore);
      }
    } else {
      unappliedStartRef.current = null;
      restoredMediaItemRef.current = currentPlaybackInstanceKey;
    }
  }, [
    compatibilityPlaybackEnabled,
    currentPlaybackInstanceKey,
    currentTrack?.locationId,
    currentTrack?.mediaItemId,
    startPositionRequest,
  ]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (isPlaying) {
      requestAudioPlay(audio, currentPlaybackInstanceKey);
    } else {
      sourceLoadingRef.current = false;
      invalidatePlaybackRequests();
      audio.pause();
    }
  }, [
    compatibilityPlaybackEnabled,
    isPlaying,
    currentTrack,
    currentPlaybackInstanceKey,
    invalidatePlaybackRequests,
    requestAudioPlay,
  ]);

  const nextTrackIndex = nextAutoAdvanceIndex(currentIndex, queue.length, mode);
  const nextTrack = nextTrackIndex === null || sleepTimer?.waitingForTrackEnd ? null : (queue[nextTrackIndex] ?? null);
  const nextTrackCompatibility = Boolean(
    nextTrack &&
    (nextTrack.locationType === "local" || nextTrack.locationType === "cache") &&
    playbackCompatibilityLoadedKey === playbackCompatibilityStorageKey &&
    ((playbackCompatibilityScope === "always" && playbackCompatibilityTarget === null) ||
      (playbackCompatibilityScope === "queue" && playbackCompatibilityTarget === queueSessionRef.current)),
  );
  const [preloadArmedInstanceKey, setPreloadArmedInstanceKey] = useState<string | null>(null);
  const preloadArmed = currentPlaybackInstanceKey !== null && preloadArmedInstanceKey === currentPlaybackInstanceKey;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack || !currentPlaybackInstanceKey || preloadArmed) return;
    if (durationLocationId !== currentTrack.locationId) return;
    if (shouldPreloadNextTrack({ playing: isPlaying, currentTime, duration, bufferedEnd: bufferedEndAt(audio) })) {
      setPreloadArmedInstanceKey(currentPlaybackInstanceKey);
    }
  }, [currentPlaybackInstanceKey, currentTime, duration, durationLocationId, isPlaying, preloadArmed]);

  const nextTrackPreloadURL = useMemo(() => {
    if (!preloadArmed || !nextTrack || !currentTrack) return null;
    const url = assetURL(playerTrackAudioURL(nextTrack, nextTrackCompatibility));
    const currentURL = assetURL(playerTrackAudioURL(currentTrack, compatibilityPlaybackEnabled));
    return url && url !== currentURL ? url : null;
  }, [
    compatibilityPlaybackEnabled,
    currentTrack?.locationType,
    currentTrack?.remotePath,
    currentTrack?.streamUrl,
    nextTrack?.locationType,
    nextTrack?.remotePath,
    nextTrack?.remoteSourceId,
    nextTrack?.remoteWorkCode,
    nextTrack?.streamUrl,
    nextTrackCompatibility,
    preloadArmed,
  ]);
  useNextTrackPreload(nextTrackPreloadURL);

  const playQueue = useCallback(
    (tracks: PlayerTrack[], locationId: number, startPositionSeconds?: number) => {
      if (tracks.length === 0) return;
      resetTransientPlaybackCompatibility();
      invalidatePlaybackRequests();
      resetTrackLocationFailures(locationFailureStateRef.current);
      progressSaveRef.current(false, true);
      const normalizedTracks = tracks.map((track) =>
        withQueueIdentity(applyLyricsPreferenceOverride(track, lyricsPreferenceOverridesRef.current)),
      );
      const nextIndex = Math.max(
        0,
        normalizedTracks.findIndex((track) => track.locationId === locationId),
      );
      const startTrack = normalizedTracks[nextIndex];
      pendingPlaybackStartRef.current = startTrack?.queueItemId
        ? {
            queueItemId: startTrack.queueItemId,
            positionSeconds: normalizePlaybackStartPosition(startPositionSeconds),
          }
        : null;
      setQueue(normalizedTracks);
      setCurrentIndex(nextIndex);
      updatePlayingState(true);
    },
    [invalidatePlaybackRequests, resetTransientPlaybackCompatibility, updatePlayingState],
  );

  const selectTrack = (index: number) => {
    if (index < 0 || index >= queue.length) return;
    if (index !== currentIndex) progressSaveRef.current(false, true);
    if (index !== currentIndex) invalidatePlaybackRequests();
    setCurrentIndex(index);
    updatePlayingState(true);
  };

  const next = () => {
    if (queue.length === 0) return;
    const nextIndex = currentIndex < queue.length - 1 ? currentIndex + 1 : mode === "loop" ? 0 : currentIndex;
    if (nextIndex !== currentIndex) progressSaveRef.current(false, true);
    if (nextIndex !== currentIndex) invalidatePlaybackRequests();
    setCurrentIndex(nextIndex);
    updatePlayingState(true);
  };

  const previous = () => {
    if (queue.length === 0) return;
    const nextIndex = currentIndex > 0 ? currentIndex - 1 : mode === "loop" ? queue.length - 1 : currentIndex;
    if (nextIndex !== currentIndex) progressSaveRef.current(false, true);
    if (nextIndex !== currentIndex) invalidatePlaybackRequests();
    setCurrentIndex(nextIndex);
    updatePlayingState(true);
  };

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(seconds)) return;
      const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
      const nextTime = Math.max(0, Math.min(seconds, mediaDuration));
      clearPendingSeek();
      pendingSeekTargetRef.current = nextTime;
      try {
        audio.currentTime = nextTime;
      } catch {
        pendingSeekTargetRef.current = null;
        return;
      }
      listenerIntentInstanceRef.current = currentPlaybackInstanceKeyRef.current;
      pendingSeekTimerRef.current = window.setTimeout(() => {
        if (pendingSeekTargetRef.current !== nextTime) return;
        clearPendingSeek();
        const currentAudio = audioRef.current;
        if (!currentAudio) return;
        lastPlayerTimeCommitRef.current = performance.now();
        setCurrentTime(currentAudio.currentTime);
        nativeMediaSyncRef.current();
      }, 3_000);
      lastPlayerTimeCommitRef.current = performance.now();
      setCurrentTime(nextTime);
      nativeMediaSyncRef.current();
    },
    [clearPendingSeek, duration],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seekTo(audio.currentTime + seconds);
    },
    [seekTo],
  );

  const seekBackward = useCallback(() => seekBy(-seekPreferencesRef.current.seekBackwardSeconds), [seekBy]);
  const seekForward = useCallback(() => seekBy(seekPreferencesRef.current.seekForwardSeconds), [seekBy]);

  const saveProgress = (completed: boolean, force = false) => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (!currentTrack.progressRecordable) return;
    if (currentTrack.mediaItemId <= 0) return;
    // A save captured by an older render would pair this track's id with another track's audio position.
    if (currentPlaybackInstanceKey !== currentPlaybackInstanceKeyRef.current) return;
    // An idle or still-loading element must not replace the persisted cursor with its own 0.
    if (
      !canPersistPlaybackProgress(
        currentPlaybackInstanceKey,
        restoredMediaItemRef.current,
        listenerIntentInstanceRef.current,
      )
    )
      return;
    const durationValue =
      [
        audio.duration,
        durationLocationId === currentTrack.locationId ? duration : null,
        currentTrack.durationSeconds,
        currentTrack.progress?.durationSeconds,
      ].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0) ?? null;
    const position = completed ? (durationValue ?? audio.currentTime) : audio.currentTime;
    if (!Number.isFinite(position) || position < 0) return;
    const now = Date.now();
    const marker = { mediaItemId: currentTrack.mediaItemId, position, completed, at: now };
    if (!auth.user || auth.demoMode) return;
    if (!shouldSaveRemoteProgress(lastSavedRef.current, marker, force)) return;
    lastSavedRef.current = marker;
    queueProgressSave(currentTrack.mediaItemId, {
      locationId: currentTrack.locationId,
      positionSeconds: position,
      durationSeconds: durationValue,
      completed,
    });
  };

  const queueProgressSave = (mediaItemId: number, payload: ProgressSavePayload) => {
    const queueState = progressSaveQueueRef.current;
    queueState.pending.set(mediaItemId, payload);
    if (queueState.inFlight) return;
    queueState.inFlight = true;
    void (async () => {
      while (queueState.pending.size > 0) {
        const next = queueState.pending.entries().next().value as [number, ProgressSavePayload] | undefined;
        if (!next) break;
        queueState.pending.delete(next[0]);
        await saveProgressWithBusyRetry(next[0], next[1]);
      }
      queueState.inFlight = false;
    })();
  };

  progressSaveRef.current = saveProgress;

  useEffect(() => () => clearPendingSeek(), [clearPendingSeek]);

  useEffect(() => {
    const flushProgress = () => progressSaveRef.current(false, true);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushProgress();
    };
    window.addEventListener("pagehide", flushProgress);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushProgress);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

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
      // This effect outlives track changes; only the latest save knows the current track.
      progressSaveRef.current(false, true);
      updatePlayingState(false);
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
    setIsBuffering(false);
    completedPlaybackInstanceRef.current = currentPlaybackInstanceKey;
    saveProgress(true, true);
    if (sleepTimer?.waitingForTrackEnd) {
      setSleepTimer(null);
      updatePlayingState(false);
      return;
    }
    if (mode === "single" && audio) {
      audio.currentTime = 0;
      sourceLoadingRef.current = false;
      updatePlayingState(true);
      requestAudioPlay(audio, currentPlaybackInstanceKey);
      return;
    }
    if (currentIndex < queue.length - 1) {
      setCurrentIndex((index) => index + 1);
      updatePlayingState(true);
      return;
    }
    if (mode === "loop" && queue.length > 0) {
      setCurrentIndex(0);
      updatePlayingState(true);
      return;
    }
    updatePlayingState(false);
  };

  const playNext = useCallback(
    (track: PlayerTrack) => {
      const nextTrack = withQueueIdentity(applyLyricsPreferenceOverride(track, lyricsPreferenceOverridesRef.current));
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
    setQueue((items) => [
      ...items,
      ...tracks.map((track) =>
        withQueueIdentity(applyLyricsPreferenceOverride(track, lyricsPreferenceOverridesRef.current)),
      ),
    ]);
  }, []);

  const changeLyricsChoice = useCallback(
    async (target: LyricsPreferenceTarget, choice: LyricsChoice | null) => {
      const preferenceKey = lyricsPreferenceKey(target);
      setLyricsPreferenceOverrides((current) => {
        const next = { ...current, [preferenceKey]: choice?.mediaItemId ?? null };
        lyricsPreferenceOverridesRef.current = next;
        return next;
      });
      setQueue((items) =>
        items.map((item) =>
          lyricsPreferenceKey(item) === preferenceKey ? applyLyricsChoiceToTrack(item, target, choice) : item,
        ),
      );

      const persistPreference = target.lyricsPreferencePersistable ?? target.progressRecordable ?? false;
      if (!persistPreference || target.mediaItemId <= 0) return;
      try {
        if (choice && choice.mediaItemId > 0) {
          await api.setMediaLyricsPreference(target.mediaItemId, choice.mediaItemId);
        } else {
          await api.clearMediaLyricsPreference(target.mediaItemId);
        }
      } catch (error) {
        toast.notify({
          kind: "warning",
          message:
            error instanceof Error
              ? error.message
              : choice
                ? "Lyrics preference could not be saved."
                : "Lyrics preference could not be cleared.",
        });
      }
    },
    [toast],
  );

  const moveQueueItemTo = (queueItemId: string, targetIndex: number) => {
    setQueue((items) => {
      const next = moveQueueItemToIndex(items, queueItemId, targetIndex);
      if (next === items) return items;
      const currentQueueItemId = items[currentIndex]?.queueItemId;
      if (currentQueueItemId) setCurrentIndex(next.findIndex((item) => item.queueItemId === currentQueueItemId));
      return next;
    });
  };

  const moveQueueItem = (queueItemId: string, direction: -1 | 1) => {
    const from = queue.findIndex((item) => item.queueItemId === queueItemId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= queue.length) return;
    moveQueueItemTo(queueItemId, to);
  };

  const removeQueueItem = (queueItemId: string) => {
    if (queue[currentIndex]?.queueItemId === queueItemId) {
      progressSaveRef.current(false, true);
      invalidatePlaybackRequests();
    }
    setQueue((items) => {
      const removedIndex = items.findIndex((item) => item.queueItemId === queueItemId);
      if (removedIndex < 0) return items;
      const removingCurrent = removedIndex === currentIndex;
      const next = items.filter((item) => item.queueItemId !== queueItemId);
      if (next.length === 0) {
        setCurrentIndex(0);
        updatePlayingState(false);
      } else if (removedIndex < currentIndex) {
        setCurrentIndex((index) => Math.max(0, index - 1));
      } else if (removingCurrent) {
        setCurrentIndex(Math.min(removedIndex, next.length - 1));
      }
      return next;
    });
  };

  const clearQueue = () => {
    progressSaveRef.current(false, true);
    resetTransientPlaybackCompatibility();
    invalidatePlaybackRequests();
    setQueue([]);
    setCurrentIndex(0);
    updatePlayingState(false);
    setSleepTimer(null);
  };

  const selectLocation = (locationId: number) => {
    if (currentTrack?.locationId !== locationId) progressSaveRef.current(false, true);
    if (currentTrack?.locationId !== locationId) invalidatePlaybackRequests();
    if (currentTrack?.queueItemId) {
      pendingPlaybackStartRef.current = {
        queueItemId: currentTrack.queueItemId,
        positionSeconds: carriedPlaybackPosition(),
      };
    }
    resetTrackLocationFailures(locationFailureStateRef.current);
    setQueue((items) =>
      items.map((item, index) => {
        if (index !== currentIndex) return item;
        const location = item.locations?.find((candidate) => candidate.locationId === locationId);
        return location ? applyTrackLocation(item, location) : item;
      }),
    );
  };

  const switchAfterLocationFailure = useCallback(
    (failedTrack: PlayerTrack, instanceKey: string | null) => {
      if (!instanceKey || currentPlaybackInstanceKeyRef.current !== instanceKey) return;
      const activeTrack = currentTrackRef.current;
      if (!activeTrack || activeTrack.locationId !== failedTrack.locationId) return;
      const result = recordTrackLocationFailure(activeTrack, locationFailureStateRef.current);
      if (result.kind === "ignored") {
        sourceLoadingRef.current = false;
        updatePlayingState(false);
        return;
      }
      if (result.kind === "terminal") {
        sourceLoadingRef.current = false;
        updatePlayingState(false);
        const failureSequence = playbackErrorSequenceRef.current;
        toast.notify({
          kind: "error",
          message: t("player.playbackFailed", { title: activeTrack.title }),
          actionLabel: t("common.retry"),
          onAction: () => {
            if (
              currentPlaybackInstanceKeyRef.current !== instanceKey ||
              playbackErrorSequenceRef.current !== failureSequence
            )
              return;
            resetTrackLocationFailures(locationFailureStateRef.current);
            if (activeTrack.queueItemId) {
              pendingPlaybackStartRef.current = {
                queueItemId: activeTrack.queueItemId,
                positionSeconds: carriedPlaybackPosition(),
              };
            }
            setPlaybackReloadToken((value) => value + 1);
            updatePlayingState(true);
          },
        });
        return;
      }
      const nextLocation = result.location;
      progressSaveRef.current(false, true);
      if (activeTrack.queueItemId) {
        pendingPlaybackStartRef.current = {
          queueItemId: activeTrack.queueItemId,
          positionSeconds: carriedPlaybackPosition(),
        };
      }
      playbackGenerationRef.current += 1;
      playbackErrorSequenceRef.current += 1;
      sourceLoadingRef.current = true;
      setQueue((items) =>
        items.map((item, index) =>
          index === currentIndexRef.current && item.locationId === activeTrack.locationId
            ? applyTrackLocation(item, nextLocation)
            : item,
        ),
      );
      updatePlayingState(true);
      toast.warning(
        t("player.sourceFailed", {
          source:
            nextLocation.sourceName ||
            t(`player.locationTypes.${nextLocation.locationType}`, { defaultValue: nextLocation.locationType }),
        }),
      );
    },
    [carriedPlaybackPosition, t, toast, updatePlayingState],
  );

  const handlePlaybackError = useCallback(() => {
    const failedTrack = currentTrackRef.current;
    const instanceKey = currentPlaybackInstanceKeyRef.current;
    const audio = audioRef.current;
    if (!failedTrack || !instanceKey || !audio) return;
    const sequence = playbackErrorSequenceRef.current;
    playbackErrorAbortRef.current?.abort();
    const controller = new AbortController();
    playbackErrorAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 3_000);
    const sourceURL =
      audio.currentSrc || assetURL(playerTrackAudioURL(failedTrack, compatibilityPlaybackEnabledRef.current));
    sourceLoadingRef.current = false;
    setIsBuffering(false);
    updatePlayingState(false);

    void (async () => {
      let status: number | null = null;
      let alreadyTranscoded = false;
      try {
        if (typeof fetch === "function") {
          const response = await fetch(sourceURL, {
            method: "HEAD",
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "*/*" },
            signal: controller.signal,
          });
          status = response.status;
          alreadyTranscoded = response.headers.get("X-Kikoto-Playback-Delivery") === "transcoded";
        }
      } catch {
        if (controller.signal.aborted && !timedOut) return;
      } finally {
        window.clearTimeout(timeout);
      }
      if (sequence !== playbackErrorSequenceRef.current || currentPlaybackInstanceKeyRef.current !== instanceKey)
        return;
      playbackErrorAbortRef.current = null;
      if (status === 404) {
        switchAfterLocationFailure(failedTrack, instanceKey);
        return;
      }
      const canUseCompatibility = failedTrack.locationType === "local" || failedTrack.locationType === "cache";
      if (canUseCompatibility && !alreadyTranscoded && !compatibilityPlaybackEnabledRef.current) {
        toast.notify({
          kind: "error",
          message: t("player.trackFailed", { title: failedTrack.title }),
          actionLabel: t("player.compatibility"),
          onAction: () => {
            if (currentPlaybackInstanceKeyRef.current !== instanceKey) return;
            setPlaybackCompatibility("track", true);
          },
        });
        return;
      }
      switchAfterLocationFailure(failedTrack, instanceKey);
    })();
  }, [setPlaybackCompatibility, switchAfterLocationFailure, t, toast, updatePlayingState]);

  playbackErrorHandlerRef.current = handlePlaybackError;
  const tryNextLocation = handlePlaybackError;

  useEffect(() => {
    nativeControlRef.current = {
      play: () => updatePlayingState((value) => (currentTrack ? true : value)),
      pause: () => updatePlayingState(false),
      previous,
      next,
      seekBackward,
      seekForward,
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

  const syncNativeMedia = useCallback(() => {
    if (!supportsNativeMedia() || !currentTrack) return;
    const currentMediaDuration = durationLocationId === currentTrack.locationId ? duration : 0;
    const durationSeconds = [
      currentMediaDuration,
      currentTrack.durationSeconds,
      currentTrack.progress?.durationSeconds,
    ].find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const durationMs = durationSeconds ? Math.floor(durationSeconds * 1000) : 0;
    const positionSeconds = audioRef.current?.currentTime ?? 0;
    const positionMs = Math.min(Math.max(0, Math.floor(positionSeconds * 1000)), durationMs || Number.MAX_SAFE_INTEGER);
    void updateNativeMedia({
      title: currentTrack.title || currentTrack.workTitle || "Kikoto",
      artist: currentTrack.circle || currentTrack.workTitle || "Kikoto",
      album: currentTrack.workTitle || currentTrack.workCode || "Kikoto",
      coverUrl: currentTrack.coverUrl ? new URL(assetURL(currentTrack.coverUrl), window.location.href).href : "",
      playing: isPlaying,
      positionMs,
      durationMs,
      playbackRate,
      canPrevious: currentIndex > 0 || mode === "loop",
      canNext: currentIndex < queue.length - 1 || mode === "loop",
      seekBackwardSeconds: seekPreferences.seekBackwardSeconds,
      seekForwardSeconds: seekPreferences.seekForwardSeconds,
    });
  }, [
    currentTrack,
    currentIndex,
    queue.length,
    isPlaying,
    duration,
    durationLocationId,
    playbackRate,
    mode,
    seekPreferences.seekBackwardSeconds,
    seekPreferences.seekForwardSeconds,
  ]);
  nativeMediaSyncRef.current = syncNativeMedia;

  useEffect(() => {
    if (!supportsNativeMedia()) return;
    if (!currentTrack) {
      void stopNativeMedia();
      return;
    }
    syncNativeMedia();
  }, [currentTrack, syncNativeMedia]);

  useEffect(() => {
    if (!supportsNativeMedia() || !currentTrack || !isPlaying) return;
    const interval = window.setInterval(syncNativeMedia, NATIVE_MEDIA_POSITION_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [currentTrack, isPlaying, syncNativeMedia]);

  useEffect(
    () => () => {
      void stopNativeMedia();
    },
    [],
  );

  useEffect(() => {
    if (supportsNativeMedia() || !("mediaSession" in navigator)) return;
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
      ["play", () => updatePlayingState(true)],
      ["pause", () => updatePlayingState(false)],
      ["previoustrack", previous],
      ["nexttrack", next],
      ["seekbackward", seekBackward],
      ["seekforward", seekForward],
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
    currentPlaybackKey,
    currentTrack?.locationId,
    currentTrack?.title,
    currentTrack?.workTitle,
    currentTrack?.circle,
    currentTrack?.coverUrl,
    currentIndex,
    queue.length,
    seekBackward,
    seekForward,
  ]);

  useEffect(() => {
    if (supportsNativeMedia() || !("mediaSession" in navigator)) return;
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

  useEffect(() => {
    const handlePlayerShortcut = (event: KeyboardEvent) => {
      if (!currentTrack || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isPlayerShortcutTarget(event.target)) return;
      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        updatePlayingState((value) => !value);
        return;
      }
      const seek = event.key === "ArrowLeft" ? seekBackward : event.key === "ArrowRight" ? seekForward : null;
      if (!seek) return;
      event.preventDefault();
      seek();
    };
    window.addEventListener("keydown", handlePlayerShortcut);
    return () => window.removeEventListener("keydown", handlePlayerShortcut);
  }, [currentPlaybackKey, currentTrack?.locationId, seekBackward, seekForward]);

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
      togglePlay: () => updatePlayingState((value) => (currentTrack ? !value : false)),
      pause: () => updatePlayingState(false),
      next,
      previous,
      seekBy,
      seekTo,
      seekBackward,
      seekForward,
      seekBackwardSeconds: seekPreferences.seekBackwardSeconds,
      seekForwardSeconds: seekPreferences.seekForwardSeconds,
      cyclePlaybackRate: () =>
        setPlaybackRate((value) => {
          const rates = [0.75, 1, 1.25, 1.5, 2];
          const index = rates.indexOf(value);
          return rates[(index + 1) % rates.length];
        }),
      setPlaybackRate: (rate) => {
        if ([0.75, 1, 1.25, 1.5, 2].includes(rate)) setPlaybackRate(rate);
      },
      playNext,
      appendQueue,
      moveQueueItem,
      moveQueueItemTo,
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
      seekPreferences.seekBackwardSeconds,
      seekPreferences.seekForwardSeconds,
      seekBackward,
      seekForward,
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
      currentTrack?.locationId,
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
        <audio
          ref={audioRef}
          preload="metadata"
          onLoadStart={() => setIsBuffering(true)}
          onWaiting={() => setIsBuffering(true)}
          onCanPlay={() => setIsBuffering(false)}
          onPlaying={() => {
            setIsBuffering(false);
            if (isPlayingRef.current) listenerIntentInstanceRef.current = currentPlaybackInstanceKey;
          }}
          onEmptied={() => setIsBuffering(false)}
          onTimeUpdate={(event) => {
            const now = performance.now();
            const nextTime = event.currentTarget.currentTime;
            const pendingSeekTarget = pendingSeekTargetRef.current;
            if (pendingSeekTarget !== null) {
              if (Math.abs(nextTime - pendingSeekTarget) > 0.5) return;
              clearPendingSeek();
            }
            const jumped = Math.abs(nextTime - currentTime) >= 1;
            if (shouldCommitPlayerTime(lastPlayerTimeCommitRef.current, now, jumped)) {
              lastPlayerTimeCommitRef.current = now;
              setCurrentTime(nextTime);
            }
            saveProgress(false);
          }}
          onLoadedMetadata={(event) => {
            const mediaDuration = event.currentTarget.duration;
            const knownDuration = currentTrackRef.current?.durationSeconds ?? null;
            setDuration(
              Number.isFinite(mediaDuration) && mediaDuration > 0
                ? mediaDuration
                : typeof knownDuration === "number" && Number.isFinite(knownDuration) && knownDuration > 0
                  ? knownDuration
                  : 0,
            );
          }}
          onDurationChange={(event) => {
            const mediaDuration = event.currentTarget.duration;
            if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
              setDuration(mediaDuration);
              return;
            }
            const knownDuration = currentTrackRef.current?.durationSeconds ?? null;
            if (typeof knownDuration === "number" && Number.isFinite(knownDuration) && knownDuration > 0) {
              setDuration(knownDuration);
            }
          }}
          onPlay={() => {
            if (!isPlayingRef.current) {
              audioRef.current?.pause();
              return;
            }
            sourceLoadingRef.current = false;
            completedPlaybackInstanceRef.current = null;
            updatePlayingState(true);
          }}
          onPause={() => {
            if (sourceLoadingRef.current || isPlayingRef.current) return;
            const audio = audioRef.current;
            if (audio) {
              lastPlayerTimeCommitRef.current = performance.now();
              setCurrentTime(audio.currentTime);
            }
            if (shouldCheckpointPause(completedPlaybackInstanceRef.current, currentPlaybackInstanceKey)) {
              saveProgress(false, true);
            }
            updatePlayingState(false);
          }}
          onSeeked={(event) => {
            const nextTime = event.currentTarget.currentTime;
            const pendingSeekTarget = pendingSeekTargetRef.current;
            if (pendingSeekTarget !== null && Math.abs(nextTime - pendingSeekTarget) > 0.5) return;
            clearPendingSeek();
            lastPlayerTimeCommitRef.current = performance.now();
            setCurrentTime(nextTime);
            nativeMediaSyncRef.current();
            saveProgress(false, true);
          }}
          onEnded={handleEnded}
          onError={tryNextLocation}
        />
      </PlayerContext.Provider>
    </LibraryPlayerContext.Provider>
  );
}

function playerTrackAudioURL(track: PlayerTrack, compatibilityMode = false) {
  if (track.locationType === "remote_stream" && track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return remoteMediaPlaybackURL(track.remoteSourceId, track.remoteWorkCode, track.remotePath, "audio");
  }
  return playbackURL(track.streamUrl, "audio", compatibilityMode, !compatibilityMode);
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

function remoteCacheKey(track: PlayerTrack) {
  if (track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return `source:${track.remoteSourceId}:${track.remoteWorkCode}:${track.remotePath}`;
  }
  return `location:${track.locationId}`;
}

function trackPlaybackKey(track: PlayerTrack | null) {
  if (!track) return null;
  if (track.playbackKey) return track.playbackKey;
  if (track.remoteSourceId && track.remoteWorkCode && track.remotePath) {
    return remotePlaybackKey(track.remoteSourceId, track.remoteWorkCode, track.remotePath);
  }
  return playbackKeyForLocation(track.locationId);
}

function isPlayerShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='slider'], [role='dialog']",
    ),
  );
}

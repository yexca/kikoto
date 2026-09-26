import { useCallback, useEffect, useRef, useState } from "react";

import { loadPersistedPlaybackCompatibility } from "./playerPersistence";
import { supportsCompatibilityPlayback } from "./playerTrackMedia";
import type { PlaybackCompatibilityScope, PlayerTrack } from "./playerTypes";
import type { PlaybackEngine } from "./usePlaybackEngine";

function createPlaybackSessionID() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function compatibilityTrackKey(track: PlayerTrack | null) {
  return track ? (track.queueItemId ?? `media:${track.mediaItemId}:${track.workCode}`) : null;
}

/**
 * Compatibility (transcoded) playback for local and cached files. "track" and
 * "queue" last for one item or one queue session; only "always" is persisted.
 */
export function usePlaybackCompatibility(storageKey: string, engine: PlaybackEngine) {
  const { refs, currentTrack, carriedPlaybackPosition, cancelPlaybackErrorCheck, updatePlayingState } = engine;
  const [scope, setScopeState] = useState<PlaybackCompatibilityScope>(() =>
    loadPersistedPlaybackCompatibility(storageKey),
  );
  const [target, setTarget] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState(storageKey);
  const [initialQueueSession] = useState(createPlaybackSessionID);
  const queueSessionRef = useRef(initialQueueSession);
  const scopeRef = useRef(scope);
  const targetRef = useRef(target);
  const storageKeyRef = useRef(storageKey);
  scopeRef.current = scope;
  targetRef.current = target;

  const trackKey = compatibilityTrackKey(currentTrack);
  const scopeLoaded = loadedKey === storageKey;
  const queueWideEnabled =
    scopeLoaded &&
    ((scope === "always" && target === null) || (scope === "queue" && target === queueSessionRef.current));
  const compatibilityPlaybackEnabled = Boolean(
    supportsCompatibilityPlayback(currentTrack) &&
    (queueWideEnabled || (scopeLoaded && scope === "track" && target === trackKey)),
  );
  refs.compatibilityPlaybackEnabledRef.current = compatibilityPlaybackEnabled;

  const setPlaybackCompatibility = useCallback(
    (nextScope: PlaybackCompatibilityScope, resume = false) => {
      const track = refs.currentTrackRef.current;
      if (nextScope !== "off" && !track) return;
      const nextTarget =
        nextScope === "track" ? compatibilityTrackKey(track) : nextScope === "queue" ? queueSessionRef.current : null;
      const nextCompatibilityEnabled = Boolean(track && supportsCompatibilityPlayback(track) && nextScope !== "off");
      if (nextCompatibilityEnabled !== refs.compatibilityPlaybackEnabledRef.current && track?.queueItemId) {
        refs.pendingPlaybackStartRef.current = {
          queueItemId: track.queueItemId,
          positionSeconds: carriedPlaybackPosition(),
        };
      }
      scopeRef.current = nextScope;
      targetRef.current = nextTarget;
      setScopeState(nextScope);
      setTarget(nextTarget);
      cancelPlaybackErrorCheck();
      if (resume && track) updatePlayingState(true);
    },
    [cancelPlaybackErrorCheck, carriedPlaybackPosition, refs, updatePlayingState],
  );

  // A new queue starts a new session, so "track" and "queue" choices end with it.
  const resetTransientPlaybackCompatibility = useCallback(() => {
    queueSessionRef.current = createPlaybackSessionID();
    if (scopeRef.current === "always") {
      targetRef.current = null;
      setTarget(null);
      return;
    }
    scopeRef.current = "off";
    targetRef.current = null;
    setScopeState("off");
    setTarget(null);
  }, []);

  useEffect(() => {
    if (storageKeyRef.current !== storageKey) {
      storageKeyRef.current = storageKey;
      const restoredScope = loadPersistedPlaybackCompatibility(storageKey);
      scopeRef.current = restoredScope;
      targetRef.current = null;
      setScopeState(restoredScope);
      setTarget(null);
      setLoadedKey(storageKey);
      return;
    }
    try {
      if (scope === "always") {
        localStorage.setItem(storageKey, JSON.stringify({ version: 1, scope: "always" }));
      } else {
        localStorage.removeItem(storageKey);
      }
    } catch {
      // Playback remains usable when browser storage is unavailable.
    }
  }, [loadedKey, scope, storageKey]);

  useEffect(() => {
    if (scope !== "track" || target === trackKey) return;
    scopeRef.current = "off";
    targetRef.current = null;
    setScopeState("off");
    setTarget(null);
  }, [scope, target, trackKey]);

  return {
    playbackCompatibilityScope: scope,
    compatibilityPlaybackEnabled,
    /** Whether compatibility playback also applies to the next queued item. */
    queueWideCompatibilityEnabled: queueWideEnabled,
    setPlaybackCompatibility,
    resetTransientPlaybackCompatibility,
  };
}

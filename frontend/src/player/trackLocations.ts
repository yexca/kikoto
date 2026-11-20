import type { PlayerTrack, PlayerTrackLocation } from "./playerTypes";
import { playbackKeyForLocation } from "./playbackIdentity";

/**
 * The locations a track can play from, in the order the server ranks them
 * (local, then cached, then remote; see the work media `playbackLocations`).
 * A track that lists none plays only from its own location.
 */
export function orderedTrackLocations(track: PlayerTrack | null): PlayerTrackLocation[] {
  if (!track) return [];
  if (track.locations?.length) return track.locations;
  return [
    {
      locationId: track.locationId,
      locationType: track.locationType,
      streamUrl: track.streamUrl,
      sourceId: track.remoteSourceId ?? 0,
      sourceName: track.locationType,
      availability: track.availability,
    },
  ];
}

/** Moves the track to a location. The move is automatic, so it drops a location the listener picked. */
export function applyTrackLocation(track: PlayerTrack, location: PlayerTrackLocation): PlayerTrack {
  const { locationChosen: _locationChosen, ...rest } = track;
  return {
    ...rest,
    locationId: location.locationId,
    locationType: location.locationType,
    streamUrl: location.streamUrl,
    availability: location.availability,
    playbackKey:
      track.remoteSourceId && track.remoteWorkCode && track.remotePath
        ? track.playbackKey
        : playbackKeyForLocation(location.locationId),
  };
}

/**
 * Returns the track moved to one of its listed locations as the listener's
 * own choice, or null when it already plays from that location or does not
 * list it, so a manual source choice that changes nothing reloads nothing and
 * carries no start position.
 */
export function switchTrackLocation(track: PlayerTrack, locationId: number): PlayerTrack | null {
  if (track.locationId === locationId) return null;
  const location = track.locations?.find((candidate) => candidate.locationId === locationId);
  return location ? { ...applyTrackLocation(track, location), locationChosen: true } : null;
}

export type TrackLocationFailureState = {
  failedLocationIds: Set<number>;
  terminal: boolean;
};

export type TrackLocationFailureResult =
  { kind: "switch"; location: PlayerTrackLocation } | { kind: "terminal" } | { kind: "ignored" };

export function createTrackLocationFailureState(): TrackLocationFailureState {
  return { failedLocationIds: new Set(), terminal: false };
}

export function resetTrackLocationFailures(state: TrackLocationFailureState) {
  state.failedLocationIds.clear();
  state.terminal = false;
}

/** Without `allowFallback`, the first failure is terminal even when another location exists. */
export function recordTrackLocationFailure(
  track: PlayerTrack,
  state: TrackLocationFailureState,
  { allowFallback }: { allowFallback: boolean },
): TrackLocationFailureResult {
  if (state.terminal || state.failedLocationIds.has(track.locationId)) return { kind: "ignored" };
  state.failedLocationIds.add(track.locationId);
  const nextLocation = allowFallback
    ? orderedTrackLocations(track).find(
        (location) =>
          location.locationId !== track.locationId &&
          !state.failedLocationIds.has(location.locationId) &&
          (location.availability === "available" || location.availability === "remote"),
      )
    : undefined;
  if (nextLocation) return { kind: "switch", location: nextLocation };
  state.terminal = true;
  return { kind: "terminal" };
}

import type { PlayerTrack, PlayerTrackLocation } from "./PlayerProvider";
import { playbackKeyForLocation } from "./playbackIdentity";

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

export function orderedTrackLocations(track: PlayerTrack | null) {
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

export function preferredTrackLocation(track: PlayerTrack | null) {
  return (
    orderedTrackLocations(track).find(
      (location) => location.availability === "available" || location.availability === "remote",
    ) ?? null
  );
}

export function applyTrackLocation(track: PlayerTrack, location: PlayerTrackLocation): PlayerTrack {
  return {
    ...track,
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

export function recordTrackLocationFailure(
  track: PlayerTrack,
  state: TrackLocationFailureState,
): TrackLocationFailureResult {
  if (state.terminal || state.failedLocationIds.has(track.locationId)) return { kind: "ignored" };
  state.failedLocationIds.add(track.locationId);
  const nextLocation = orderedTrackLocations(track).find(
    (location) =>
      location.locationId !== track.locationId &&
      !state.failedLocationIds.has(location.locationId) &&
      (location.availability === "available" || location.availability === "remote"),
  );
  if (nextLocation) return { kind: "switch", location: nextLocation };
  state.terminal = true;
  return { kind: "terminal" };
}

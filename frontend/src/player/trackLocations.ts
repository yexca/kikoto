import type { PlayerTrack, PlayerTrackLocation } from "./PlayerProvider";

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
    : [{
        locationId: track.locationId,
        locationType: track.locationType,
        streamUrl: track.streamUrl,
        sourceId: track.remoteSourceId ?? 0,
        sourceName: track.locationType,
        availability: track.availability,
      }];
  return [...locations].sort(
    (left, right) => locationPriority(left.locationType) - locationPriority(right.locationType),
  );
}

export function preferredTrackLocation(track: PlayerTrack | null) {
  return orderedTrackLocations(track).find((location) =>
    location.availability === "available" || location.availability === "remote"
  ) ?? null;
}

export function applyTrackLocation(track: PlayerTrack, location: PlayerTrackLocation): PlayerTrack {
  return {
    ...track,
    locationId: location.locationId,
    locationType: location.locationType,
    streamUrl: location.streamUrl,
    availability: location.availability,
  };
}

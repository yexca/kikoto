import type { PlayerTrack } from "./playerTypes";

/**
 * The artist a track shows beside its title: the work's voice actors, then its
 * circle when it credits none, then the work title.
 */
export function playerTrackArtist(track: Pick<PlayerTrack, "voiceActors" | "circle" | "workTitle">) {
  const voices = Array.isArray(track.voiceActors)
    ? track.voiceActors.filter((name) => typeof name === "string" && name.trim() !== "")
    : [];
  return voices.length > 0 ? voices.join(", ") : track.circle || track.workTitle;
}

export type PlaybackRequestIdentity = {
  generation: number;
  playbackKey: string | null;
};

export function isActivePlaybackRequest(
  request: PlaybackRequestIdentity,
  currentGeneration: number,
  currentPlaybackKey: string | null,
  wantsPlayback: boolean,
) {
  return wantsPlayback && request.generation === currentGeneration && request.playbackKey === currentPlaybackKey;
}

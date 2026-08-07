export function normalizePlaybackStartPosition(positionSeconds?: number) {
  return positionSeconds !== undefined && Number.isFinite(positionSeconds) && positionSeconds > 0 ? positionSeconds : 0;
}

export function shouldCheckpointPause(
  completedPlaybackInstanceKey: string | null,
  currentPlaybackInstanceKey: string | null,
) {
  return completedPlaybackInstanceKey === null || completedPlaybackInstanceKey !== currentPlaybackInstanceKey;
}

export const PLAYER_UI_PROGRESS_INTERVAL_MS = 500;
export const NATIVE_MEDIA_POSITION_INTERVAL_MS = 5_000;

export function shouldCommitPlayerTime(lastCommittedAt: number | null, now: number, force = false) {
  return (
    force ||
    lastCommittedAt === null ||
    now < lastCommittedAt ||
    now - lastCommittedAt >= PLAYER_UI_PROGRESS_INTERVAL_MS
  );
}

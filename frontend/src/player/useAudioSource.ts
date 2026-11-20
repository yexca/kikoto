import { useEffect, useRef, useState } from "react";

import { audioSourceKey, peekAudioSource, resolveAudioSource, type PlayerAudioSource } from "./audioPlaybackSource";
import type { PlayerTrack } from "./playerTypes";

type ResolvedSource = { key: string; instanceKey: string; source: PlayerAudioSource };

/**
 * The source a track plays from. A fixed track, or one whose playback info was
 * fetched lately (the next track, warmed ahead of its turn), has its source
 * on the first render; otherwise the hook returns null until the server has
 * decided. `instanceKey` names one load of the track, so a retry decides again.
 */
export function useAudioSource(
  track: PlayerTrack | null,
  compatibility: boolean,
  instanceKey = "",
): PlayerAudioSource | null {
  const key = track ? audioSourceKey(track, compatibility) : null;
  const trackRef = useRef(track);
  trackRef.current = track;
  const [resolved, setResolved] = useState<ResolvedSource | null>(null);
  const resolvedHere = resolved !== null && resolved.key === key && resolved.instanceKey === instanceKey;
  const known = track && !resolvedHere ? peekAudioSource(track, compatibility) : null;
  const needsResolving = key !== null && !resolvedHere && known === null;

  useEffect(() => {
    const target = trackRef.current;
    if (!needsResolving || !target || key === null) return;
    let current = true;
    void resolveAudioSource(target, compatibility).then((source) => {
      if (current) setResolved({ key, instanceKey, source });
    });
    return () => {
      current = false;
    };
  }, [compatibility, instanceKey, key, needsResolving]);

  return resolvedHere ? resolved.source : known;
}

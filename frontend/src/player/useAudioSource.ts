import { useEffect, useRef, useState } from "react";

import { startLoad } from "@/lib/effectScope";
import { audioSourceKey, peekAudioSource, resolveAudioSource, type PlayerAudioSource } from "./audioPlaybackSource";
import type { PlayerTrack } from "./playerTypes";

type ResolvedSource = { key: string; instanceKey: string; source: PlayerAudioSource };

/**
 * The source a track plays from. A fixed track, or one whose playback info was
 * fetched lately or held for its turn (the next track, warmed ahead of it), has
 * its source on the first render; otherwise the hook returns null until the
 * server has decided. The source then holds for the load. `instanceKey` names
 * one load of the track, so a retry decides again.
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

  // A source the cache knew stays this load's source once the cache entry
  // expires, so a playing track never loses its source mid-play.
  useEffect(() => {
    if (known === null || key === null) return;
    setResolved({ key, instanceKey, source: known });
  }, [instanceKey, key, known]);

  useEffect(() => {
    const target = trackRef.current;
    if (!needsResolving || !target || key === null) return;
    return startLoad(() => resolveAudioSource(target, compatibility), {
      onSuccess: (source) => setResolved({ key, instanceKey, source }),
    });
  }, [compatibility, instanceKey, key, needsResolving]);

  return resolvedHere ? resolved.source : known;
}

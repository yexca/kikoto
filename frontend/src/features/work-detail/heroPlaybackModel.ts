import { nodeAtPath, recommendedDirectoryPath, sortedFiles } from "@/features/work-detail/directory/directoryModel";
import { playableFiles, type TreeNode, type TreeTrack } from "@/features/work-detail/media/mediaTreeModel";
import type { DirectoryRoutingRule } from "@/lib/api";

/** Why the shown source has nothing to play. */
export type HeroPlaybackBlock = "no_source" | "offline" | "unavailable";

/** Why the Hero has nothing to play, as the place of its primary action says it. */
export type HeroPlaybackUnavailableReason = HeroPlaybackBlock | "no_media";

/**
 * The Hero's one primary action: continue the saved playback, play the folder
 * the Directory opens on, wait while either is still unknown, or say why
 * nothing can play.
 */
export type HeroPlayback =
  | { kind: "resume" }
  | { kind: "play"; tracks: TreeTrack[]; locationId: number }
  | { kind: "loading" }
  | { kind: "unavailable"; reason: HeroPlaybackUnavailableReason };

export function heroPlayback({
  root,
  routingRules,
  loading,
  resumable,
  blocked = null,
}: {
  /** The shown source's directory. */
  root: TreeNode;
  routingRules: DirectoryRoutingRule[];
  /** The directory or the saved playback is still loading. */
  loading: boolean;
  /** The work has a saved playback to continue, which plays whatever source is shown. */
  resumable: boolean;
  blocked?: HeroPlaybackBlock | null;
}): HeroPlayback {
  if (resumable) return { kind: "resume" };
  if (loading) return { kind: "loading" };
  if (blocked) return { kind: "unavailable", reason: blocked };
  // The folder the Directory opens on, so the Hero plays what opening its first track would.
  const folder = nodeAtPath(root, recommendedDirectoryPath(root, routingRules)) ?? root;
  const tracks = playableFiles(sortedFiles(folder));
  if (tracks.length === 0) return { kind: "unavailable", reason: "no_media" };
  return { kind: "play", tracks, locationId: tracks[0].locationId };
}

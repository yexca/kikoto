import type { useToast } from "@/components/ui/toast";
import i18n from "@/i18n";
import { originalFileNamesShown } from "@/lib/originalFileNames";
import type { useLibraryPlayer } from "@/player/PlayerProvider";
import { playerTrackTitle } from "@/player/playerTrackTitle";
import type { PlayerTrack } from "@/player/playerTypes";

/** Plays a detail track next or appends it to the queue, and says which by the name the player shows. */
export function queuePlayerTrack(
  player: Pick<ReturnType<typeof useLibraryPlayer>, "playNext" | "appendQueue">,
  toast: ReturnType<typeof useToast>,
  track: PlayerTrack,
  next: boolean,
) {
  if (next) player.playNext(track);
  else player.appendQueue([track]);
  const title = playerTrackTitle(track, originalFileNamesShown());
  toast.info(next ? i18n.t("libraryDetail.playingNext", { title }) : i18n.t("libraryDetail.addedToQueue", { title }));
}

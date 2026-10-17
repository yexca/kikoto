import type { useToast } from "@/components/ui/toast";
import i18n from "@/i18n";
import type { useLibraryPlayer } from "@/player/PlayerProvider";
import type { PlayerTrack } from "@/player/playerTypes";

/** Plays a detail track next or appends it to the queue, and says which. */
export function queuePlayerTrack(
  player: Pick<ReturnType<typeof useLibraryPlayer>, "playNext" | "appendQueue">,
  toast: ReturnType<typeof useToast>,
  track: PlayerTrack,
  title: string,
  next: boolean,
) {
  if (next) player.playNext(track);
  else player.appendQueue([track]);
  toast.info(next ? i18n.t("libraryDetail.playingNext", { title }) : i18n.t("libraryDetail.addedToQueue", { title }));
}

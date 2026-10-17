import { useEffect } from "react";

import { REMOTE_TRACK_TERMINAL_EVENT, type RemoteTrackTerminalDetail } from "@/app/remoteTrackWorkflows";
import {
  WORK_DETAIL_PLAY_EVENT,
  WORK_DETAIL_USER_STATE_EVENT,
  WORK_DETAIL_WORKS_CHANGED_EVENT,
  type WorkDetailPlayDetail,
  type WorkDetailUserStateDetail,
} from "@/app/workDetailEvents";
import { useStableCallback } from "@/hooks/useStableCallback";
import type { RecommendationEventInput, Work } from "@/lib/api";
import type { LibraryTab } from "@/pages/library/libraryRoutes";
import type { useLocalLibraryWorks } from "@/pages/library/useLocalLibraryWorks";

/**
 * Keeps the retained Library list in step with what happens elsewhere: a
 * finished track reloads the page it changed, and work detail, another page,
 * reports user state, playback, and work changes back to the list.
 */
export function useLibraryWorkEvents({
  active,
  activeTab,
  localWorks,
  reloadRemoteSource,
  refreshLocalWorks,
  recordWorkEvent,
}: {
  active: boolean;
  activeTab: LibraryTab;
  localWorks: Pick<ReturnType<typeof useLocalLibraryWorks>, "patchWork" | "worksRef">;
  /** Reloads the open remote source in place. */
  reloadRemoteSource: () => void;
  refreshLocalWorks: () => Promise<void>;
  recordWorkEvent: (work: Work, eventType: RecommendationEventInput["eventType"]) => void;
}) {
  const refreshAfterTrack = useStableCallback((event: Event) => {
    const terminal = (event as CustomEvent<RemoteTrackTerminalDetail>).detail;
    if (!terminal || (terminal.status !== "succeeded" && terminal.status !== "partial")) return;
    if (activeTab.kind === "source") {
      if (activeTab.source.id === terminal.sourceId) reloadRemoteSource();
      return;
    }
    void refreshLocalWorks();
  });
  useEffect(() => {
    if (!active) return;
    window.addEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
    return () => window.removeEventListener(REMOTE_TRACK_TERMINAL_EVENT, refreshAfterTrack);
  }, [active, refreshAfterTrack]);

  const followDetailUserState = useStableCallback((event: Event) => {
    const { ownerPage, workID, listeningStatus, favorite } = (event as CustomEvent<WorkDetailUserStateDetail>).detail;
    localWorks.patchWork(workID, { listeningStatus, favorite });
    const work = localWorks.worksRef.current.find((item) => item.id === workID);
    if (ownerPage === "library" && work && ["relisten", "paused"].includes(listeningStatus)) {
      recordWorkEvent(work, listeningStatus === "paused" ? "paused_mark" : "positive_mark");
    }
  });
  const followDetailPlay = useStableCallback((event: Event) => {
    const { ownerPage, workID } = (event as CustomEvent<WorkDetailPlayDetail>).detail;
    const work = localWorks.worksRef.current.find((item) => item.id === workID);
    if (ownerPage === "library" && work) recordWorkEvent(work, "play");
  });
  const followDetailWorksChanged = useStableCallback(() => {
    void refreshLocalWorks().catch(() => {});
  });
  useEffect(() => {
    window.addEventListener(WORK_DETAIL_USER_STATE_EVENT, followDetailUserState);
    window.addEventListener(WORK_DETAIL_PLAY_EVENT, followDetailPlay);
    window.addEventListener(WORK_DETAIL_WORKS_CHANGED_EVENT, followDetailWorksChanged);
    return () => {
      window.removeEventListener(WORK_DETAIL_USER_STATE_EVENT, followDetailUserState);
      window.removeEventListener(WORK_DETAIL_PLAY_EVENT, followDetailPlay);
      window.removeEventListener(WORK_DETAIL_WORKS_CHANGED_EVENT, followDetailWorksChanged);
    };
  }, [followDetailPlay, followDetailUserState, followDetailWorksChanged]);
}

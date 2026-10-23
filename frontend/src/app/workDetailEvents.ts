import type { PageID } from "@/app/navigation";
import type { ListeningStatus } from "@/lib/api";

/**
 * Work detail is its own page, so the retained browse lists learn what happened
 * in it from these events instead of sharing state with it.
 */
export const WORK_DETAIL_USER_STATE_EVENT = "kikoto:work-detail-user-state";
export const WORK_DETAIL_PLAY_EVENT = "kikoto:work-detail-play";
export const WORK_DETAIL_WORKS_CHANGED_EVENT = "kikoto:work-detail-works-changed";

export type WorkDetailUserStateDetail = {
  /** The page the detail was opened from. */
  ownerPage: PageID;
  workID: number;
  listeningStatus: ListeningStatus;
  favorite: boolean;
  userRating: number | null;
};

export type WorkDetailPlayDetail = {
  ownerPage: PageID;
  workID: number;
};

export function announceWorkDetailUserState(detail: WorkDetailUserStateDetail) {
  window.dispatchEvent(new CustomEvent<WorkDetailUserStateDetail>(WORK_DETAIL_USER_STATE_EVENT, { detail }));
}

export function announceWorkDetailPlay(detail: WorkDetailPlayDetail) {
  window.dispatchEvent(new CustomEvent<WorkDetailPlayDetail>(WORK_DETAIL_PLAY_EVENT, { detail }));
}

/** A detail action changed which works exist or where they are available. */
export function announceWorkDetailWorksChanged() {
  window.dispatchEvent(new Event(WORK_DETAIL_WORKS_CHANGED_EVENT));
}

import type { MediaProgressUpdate } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

export const ANDROID_BACK_EVENT = "kikoto:android-back";
export const LOGIN_REQUEST_EVENT = "kikoto:login-request";
export const PLAYBACK_CURSOR_UPDATED_EVENT = "kikoto:playback-cursor-updated";
/** The server accepted a library migration or refused a request for maintenance. */
export const SITE_MAINTENANCE_EVENT = "kikoto:site-maintenance";

/** A saved progress update, tagged with the account that saved it. */
export type PlaybackCursorUpdatedDetail = MediaProgressUpdate & { principalID: ClientPrincipalID };

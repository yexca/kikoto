import type { MediaProgressUpdate } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

/** A native back request offered to the player before history navigation. */
export const NATIVE_BACK_EVENT = "kikoto:native-back";
export const LOGIN_REQUEST_EVENT = "kikoto:login-request";
export const PLAYBACK_CURSOR_UPDATED_EVENT = "kikoto:playback-cursor-updated";
/** The server accepted a library migration or refused a request for maintenance. */
export const SITE_MAINTENANCE_EVENT = "kikoto:site-maintenance";

/** A saved progress update, tagged with the account that saved it. */
export type PlaybackCursorUpdatedDetail = MediaProgressUpdate & { principalID: ClientPrincipalID };

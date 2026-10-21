import type { MediaProgressUpdate } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

/** A native back request offered to the player before history navigation. */
export const NATIVE_BACK_EVENT = "kikoto:native-back";
export const LOGIN_REQUEST_EVENT = "kikoto:login-request";
export const PLAYBACK_CURSOR_UPDATED_EVENT = "kikoto:playback-cursor-updated";
/** A work's file display names changed; the detail is `{ workId }`. */
export const FILE_DISPLAY_NAMES_CHANGED_EVENT = "kikoto:file-display-names-changed";
/** The server accepted a library migration or refused a request for maintenance. */
export const SITE_MAINTENANCE_EVENT = "kikoto:site-maintenance";

/** A saved progress update, tagged with the account that saved it. */
export type PlaybackCursorUpdatedDetail = MediaProgressUpdate & { principalID: ClientPrincipalID };

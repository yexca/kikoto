import { postJSONBody } from "@/lib/apiTransport";
import type { Work } from "@/lib/libraryApi";

/** The three For you columns, in their order on the page. */
export const FOR_YOU_COLUMNS = ["maybe_like", "try_new", "listen_again"] as const;
export type ForYouColumn = (typeof FOR_YOU_COLUMNS)[number];

/** How far For you draws stray from what the account likes. */
export const FOR_YOU_TEMPERATURES = ["safe", "balanced", "adventurous"] as const;
export type ForYouTemperature = (typeof FOR_YOU_TEMPERATURES)[number];

/**
 * Why a work was drawn. `kind` names the sentence; the other fields are the
 * facts it uses: a tag, voice, or circle name, days since the last play, the
 * account's rating, or the DLsite rating.
 */
export type ForYouReason = {
  kind:
    | "liked_circle"
    | "liked_voice"
    | "liked_tag"
    | "want"
    | "dlsite_rating"
    | "popular"
    | "unexplored"
    | "new_circle"
    | "new_voice"
    | "rare_tag"
    | "since_played"
    | "unfinished";
  name?: string;
  days?: number;
  rating?: number;
  favorite?: boolean;
  dlsiteRating?: number;
};

export type ForYouItem = { work: Work; score: number; reason: ForYouReason };

export type ForYouColumnDraw = {
  column: ForYouColumn;
  /** Drawn without any ratings, favorites, or marks to learn from. */
  coldStart: boolean;
  items: ForYouItem[];
};

export type ForYouDraw = {
  temperature: ForYouTemperature;
  algorithmVersion: string;
  columns: ForYouColumnDraw[];
};

export type ForYouDrawRequest = {
  /** The columns to draw; all three when omitted. */
  columns?: ForYouColumn[];
  /** The account's saved temperature when omitted. */
  temperature?: ForYouTemperature;
  /** Works another column shows, which the draw leaves out. */
  exclude?: number[];
};

export const forYouApi = {
  drawForYou: (request: ForYouDrawRequest) => postJSONBody<ForYouDraw>("/api/for-you/draw", request),
};

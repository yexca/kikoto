import type { TFunction } from "i18next";

import type { ForYouColumn, ForYouItem, ForYouReason } from "@/lib/forYouApi";

/** One column as the view holds it: the drawn works and whether a draw is under way or failed. */
export type ForYouColumnState = {
  items: ForYouItem[];
  coldStart: boolean;
  drawing: boolean;
  failed: boolean;
};

export type ForYouDrawRevision = {
  all: number;
  columns: Record<ForYouColumn, number>;
};

const emptyForYouDrawRevision = (): ForYouDrawRevision => ({
  all: 0,
  columns: { maybe_like: 0, try_new: 0, listen_again: 0 },
});

/** Advances the request revisions for one full or column-only draw. */
export function advanceForYouDrawRevision(revision: ForYouDrawRevision, requested: ForYouColumn[]): ForYouDrawRevision {
  const next: ForYouDrawRevision = {
    all: revision.all,
    columns: { ...revision.columns },
  };
  if (requested.length !== 1) next.all += 1;
  for (const column of requested) next.columns[column] += 1;
  return next;
}

/** Whether a completed draw still owns the state it was allowed to update. */
export function isCurrentForYouDrawRevision(
  token: ForYouDrawRevision,
  current: ForYouDrawRevision,
  requested: ForYouColumn[],
): boolean {
  if (token.all !== current.all) return false;
  return requested.every((column) => token.columns[column] === current.columns[column]);
}

export function initialForYouDrawRevision() {
  return emptyForYouDrawRevision();
}

export function emptyForYouColumns(): Record<ForYouColumn, ForYouColumnState> {
  const drawing = (): ForYouColumnState => ({ items: [], coldStart: false, drawing: true, failed: false });
  return { maybe_like: drawing(), try_new: drawing(), listen_again: drawing() };
}

/** The works the other columns show, which a draw of `column` leaves out. */
export function otherColumnWorkIds(columns: Record<ForYouColumn, ForYouColumnState>, column: ForYouColumn): number[] {
  return (Object.keys(columns) as ForYouColumn[])
    .filter((item) => item !== column)
    .flatMap((item) => columns[item].items.map((entry) => entry.work.id));
}

/** Time since a play in the largest unit that reads naturally: days, then months, then years. */
export function elapsedLabel(days: number, t: TFunction): string {
  if (days < 45) return t("subscriptions.forYou.elapsed.days", { count: Math.max(1, Math.round(days)) });
  if (days < 365) return t("subscriptions.forYou.elapsed.months", { count: Math.round(days / 30) });
  return t("subscriptions.forYou.elapsed.years", { count: Math.round(days / 365) });
}

/** The short sentence a card shows for why it was drawn. */
export function forYouReasonText(reason: ForYouReason, t: TFunction, formatRating: (value: number) => string): string {
  const name = reason.name || t("workCard.unknownCircle");
  const key = `subscriptions.forYou.reasons.${reason.kind}`;
  switch (reason.kind) {
    case "liked_circle":
    case "liked_voice":
    case "liked_tag":
    case "new_circle":
    case "new_voice":
    case "rare_tag":
      return t(key, { name });
    case "dlsite_rating":
    case "popular":
      return t(key, { rating: formatRating(reason.dlsiteRating ?? 0) });
    case "since_played": {
      const parts = [t(key, { elapsed: elapsedLabel(reason.days ?? 0, t) })];
      if (reason.rating) parts.push(t("subscriptions.forYou.reasons.rated", { rating: reason.rating }));
      else if (reason.favorite) parts.push(t("subscriptions.forYou.reasons.favorite"));
      return parts.join(t("subscriptions.forYou.reasons.separator"));
    }
    case "unfinished":
      return t(key, { elapsed: elapsedLabel(reason.days ?? 0, t) });
    default:
      return t(key);
  }
}

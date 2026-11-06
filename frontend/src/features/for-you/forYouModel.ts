import type { TFunction } from "i18next";

import type { Work } from "@/lib/api";
import type { ForYouColumn, ForYouItem, ForYouReason, ForYouTemperature } from "@/lib/forYouApi";

// Kept here as type-checked key sets so the model stays free of the API transport.
const COLUMN_KEYS: Record<ForYouColumn, true> = { maybe_like: true, try_new: true, listen_again: true };
const TEMPERATURE_KEYS: Record<ForYouTemperature, true> = { safe: true, balanced: true, adventurous: true };
const FOR_YOU_COLUMNS = Object.keys(COLUMN_KEYS) as ForYouColumn[];

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

/**
 * The draw on screen, kept so For you shows the same works when it is opened
 * again: each column's works and the temperature they were drawn with.
 */
export type ForYouSnapshot = {
  temperature: ForYouTemperature;
  algorithmVersion: string;
  columns: Record<ForYouColumn, { items: ForYouItem[]; coldStart: boolean }>;
};

/**
 * The snapshot of the columns on screen, or null while a column is drawing or
 * a column has nothing to show because its draw failed, so a snapshot only
 * ever holds a settled draw.
 */
export function forYouSnapshotFromColumns(
  columns: Record<ForYouColumn, ForYouColumnState>,
  temperature: ForYouTemperature,
  algorithmVersion: string,
): ForYouSnapshot | null {
  if (FOR_YOU_COLUMNS.some((column) => columns[column].drawing)) return null;
  if (FOR_YOU_COLUMNS.some((column) => columns[column].failed && columns[column].items.length === 0)) return null;
  const kept = (column: ForYouColumn) => ({ items: columns[column].items, coldStart: columns[column].coldStart });
  return {
    temperature,
    algorithmVersion,
    columns: { maybe_like: kept("maybe_like"), try_new: kept("try_new"), listen_again: kept("listen_again") },
  };
}

export function forYouColumnsFromSnapshot(snapshot: ForYouSnapshot): Record<ForYouColumn, ForYouColumnState> {
  const settled = (column: ForYouColumn): ForYouColumnState => ({
    ...snapshot.columns[column],
    drawing: false,
    failed: false,
  });
  return { maybe_like: settled("maybe_like"), try_new: settled("try_new"), listen_again: settled("listen_again") };
}

/** A stored snapshot, or null when the value is not one this version wrote. */
export function parseForYouSnapshot(value: unknown): ForYouSnapshot | null {
  if (!isRecord(value) || !isRecord(value.columns)) return null;
  const { temperature, algorithmVersion, columns } = value;
  if (typeof temperature !== "string" || !Object.prototype.hasOwnProperty.call(TEMPERATURE_KEYS, temperature)) {
    return null;
  }
  if (typeof algorithmVersion !== "string") return null;
  const parsed = {} as ForYouSnapshot["columns"];
  for (const column of FOR_YOU_COLUMNS) {
    const state = columns[column];
    if (!isRecord(state) || typeof state.coldStart !== "boolean" || !Array.isArray(state.items)) return null;
    if (!state.items.every(isForYouItem)) return null;
    parsed[column] = { items: state.items, coldStart: state.coldStart };
  }
  return { temperature: temperature as ForYouTemperature, algorithmVersion, columns: parsed };
}

function isForYouItem(value: unknown): value is ForYouItem {
  return (
    isRecord(value) &&
    typeof value.score === "number" &&
    isRecord(value.reason) &&
    typeof value.reason.kind === "string" &&
    isRecord(value.work) &&
    typeof value.work.id === "number" &&
    typeof value.work.primaryCode === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The columns with `patch` applied to every card of work `workId`; the same columns when none shows it. */
export function patchForYouColumns(
  columns: Record<ForYouColumn, ForYouColumnState>,
  workId: number,
  patch: Partial<Work>,
): Record<ForYouColumn, ForYouColumnState> {
  if (!FOR_YOU_COLUMNS.some((column) => columns[column].items.some((item) => item.work.id === workId))) {
    return columns;
  }
  const next = { ...columns };
  for (const column of FOR_YOU_COLUMNS) {
    if (!columns[column].items.some((item) => item.work.id === workId)) continue;
    next[column] = {
      ...columns[column],
      items: columns[column].items.map((item) =>
        item.work.id === workId ? { ...item, work: { ...item.work, ...patch } } : item,
      ),
    };
  }
  return next;
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

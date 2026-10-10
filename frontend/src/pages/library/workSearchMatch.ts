import { ageRatingMatches } from "@/lib/ageRating";
import type { Work } from "@/lib/api";
import type { SearchClause, SearchClauseKind } from "@/lib/librarySearchClauses";

export function workMatchesSearch(work: Work, clauses: SearchClause[]) {
  if (clauses.length === 0) return true;
  return clauses.every((clause) => workMatchesClause(work, clause));
}

type WorkClauseMatcher = (work: Work, value: string, clause: SearchClause) => boolean;

const workClauseMatchers: Record<SearchClauseKind, WorkClauseMatcher> = {
  code: (work, value) => work.primaryCode.toLowerCase().includes(value),
  circle: (work, value) =>
    work.circle.toLowerCase().includes(value) || work.circleExternalId.toLowerCase().includes(value),
  exclude_circle: (work, value) =>
    !work.circle.toLowerCase().includes(value) && !work.circleExternalId.toLowerCase().includes(value),
  voice_actor: (work, value) => work.voiceActors.some((actor) => actor.toLowerCase().includes(value)),
  exclude_voice_actor: (work, value) => !work.voiceActors.some((actor) => actor.toLowerCase().includes(value)),
  tag: (work, value) => work.tags.some((tag) => tag.toLowerCase().includes(value)),
  exclude_tag: (work, value) => !work.tags.some((tag) => tag.toLowerCase().includes(value)),
  user_tag: (work, value) => (work.userTags ?? []).some((tag) => tag.name.toLowerCase().includes(value)),
  exclude_user_tag: (work, value) => !(work.userTags ?? []).some((tag) => tag.name.toLowerCase().includes(value)),
  rating_min: (work, value) => work.rating !== null && work.rating >= numericClauseValue(value),
  sales_min: (work, value) => work.sales !== null && work.sales >= numericClauseValue(value),
  duration_min: () => true,
  duration_max: () => true,
  age: (work, value) => ageRatingMatches(work.ageRating, value),
  language: (work, value) => workMatchesText([work.title, ...work.tags], value),
  shelf: (work, _value, clause) => workMatchesShelf(work, clause.value),
  text: (work, value) =>
    workMatchesText(
      [
        work.primaryCode,
        work.title,
        work.circle,
        work.circleExternalId,
        work.releaseDate ?? "",
        ...work.tags,
        ...(work.userTags ?? []).map((tag) => tag.name),
        ...work.voiceActors,
      ],
      value,
    ),
};

function workMatchesClause(work: Work, clause: SearchClause) {
  const value = clause.value.trim().toLowerCase();
  if (!value) return true;
  return workClauseMatchers[clause.kind](work, value, clause);
}

function workMatchesShelf(work: Work, value: string) {
  return value === "false"
    ? !work.favorite && work.listeningStatus === "none" && !work.progress.mediaItemId
    : work.favorite || work.listeningStatus !== "none" || Boolean(work.progress.mediaItemId);
}

function workMatchesText(values: string[], needle: string) {
  return values.some((item) => item.toLowerCase().includes(needle));
}

function numericClauseValue(value: string) {
  const number = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

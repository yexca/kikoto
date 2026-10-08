import { normalizeAgeRating } from "@/lib/ageRating";
import { historyReturnLocation, NAVIGATION_EVENT } from "@/lib/browserHistory";
import {
  defaultLibraryBrowseState,
  libraryBrowseSearch,
  libraryBrowseStateFromSearch,
  normalizeLibraryBrowseLocation,
} from "@/lib/libraryBrowseState";
import { formatSearchClause, parseSearchClauses } from "@/lib/librarySearchClauses";

/** Age chips return to their Library scope and replace its age condition. */
export function libraryAgeRatingSearchLocation(value: string, from: string, returnTo = "") {
  const rating = normalizeAgeRating(value) ?? value.trim();
  if (!rating) return null;
  const remoteDetail = new URL(from, "https://kikoto.invalid").searchParams.has("source");
  const scope =
    (remoteDetail ? null : normalizeLibraryBrowseLocation(from)) ?? normalizeLibraryBrowseLocation(returnTo) ?? "/";
  const target = new URL(scope, "https://kikoto.invalid");
  const browse = libraryBrowseStateFromSearch(target.search, defaultLibraryBrowseState);
  const clauses = parseSearchClauses(browse.query).filter((clause) => clause.kind !== "age");
  const query = [...clauses, { kind: "age" as const, value: rating }].map(formatSearchClause).join(" ");
  return `${target.pathname}${libraryBrowseSearch({ ...browse, query, page: 1, scrollY: 0 })}`;
}

export function openLibraryAgeRatingSearch(value: string) {
  const location = libraryAgeRatingSearchLocation(
    value,
    window.location.pathname + window.location.search,
    historyReturnLocation(window.history.state) ?? "",
  );
  if (!location) return;
  window.history.pushState({}, "", location);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

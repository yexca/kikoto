import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { defaultLibraryBrowseState, libraryBrowseSearch, libraryBrowseStateFromSearch } from "@/lib/libraryBrowseState";
import { formatSearchClause, parseSearchClauses } from "@/lib/librarySearchClauses";

export type LibraryTagSearchKind = "tag" | "user_tag";

// Personal tags belong to local works, so they never narrow a remote source
// or another page's query.
const localLibraryPaths = new Set(["/", "/tracked", "/library", "/library/tracked"]);

/**
 * Returns the library location that adds one tag clause to the view at
 * `from`. A personal tag opened from outside the local library starts a fresh
 * local library search instead.
 */
export function libraryTagSearchLocation(kind: LibraryTagSearchKind, tag: string, from: string) {
  const value = tag.trim();
  if (!value) return null;
  let target = new URL(from, "https://kikoto.invalid");
  if (kind === "user_tag" && !localLibraryPaths.has(target.pathname)) {
    target = new URL("/", target);
  }
  const browseState = libraryBrowseStateFromSearch(target.search, defaultLibraryBrowseState);
  const clauses = parseSearchClauses(browseState.query).filter(
    (clause) => !(clause.kind === kind && clause.value.toLowerCase() === value.toLowerCase()),
  );
  const query = [...clauses, { kind, value }].map(formatSearchClause).join(" ");
  return `${target.pathname}${libraryBrowseSearch({ ...browseState, query, page: 1, scrollY: 0 })}`;
}

export function openLibraryTagSearch(kind: LibraryTagSearchKind, tag: string, from = "/") {
  const location = libraryTagSearchLocation(kind, tag, from);
  if (!location) return;
  window.history.pushState({}, "", location);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

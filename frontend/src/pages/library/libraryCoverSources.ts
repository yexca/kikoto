import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import type { WorkCardBadge } from "@/components/work-card/WorkCardShell";

export type LibraryCoverSourceScope = { kind: "local" } | { kind: "tracked" } | { kind: "remote"; sourceId: number };

const storagePrefix = "kikoto:library-cover-sources:";

// A remote catalog presence (`source:<id>`) says another service lists the work;
// it is not a state of the Local or Tracked library, so it is never an exception there.
const remoteCatalogKey = /^source:\d+$/;

function hiddenAutomatically(badge: WorkCardBadge, scope: LibraryCoverSourceScope) {
  const key = badge.key ?? "";
  if (scope.kind !== "remote" && remoteCatalogKey.test(key)) return true;
  if (badge.variant === "warning") return false;
  if (scope.kind === "local") return key === "source:local";
  if (scope.kind === "tracked") return key.startsWith("source:tracked");
  return key === `source:remote:${scope.sourceId}`;
}

/**
 * Cover source marks for a Library card. Automatic mode drops the healthy mark
 * the current Library scope already implies and remote catalog listings, so
 * only exceptions remain (a warning about the work's own files, or the other
 * Library scope also holding it); never shows none at all.
 * `sourceUnavailableFallback` is false when an empty result is intentional.
 */
export function libraryCoverSourceBadges(
  badges: WorkCardBadge[],
  scope: LibraryCoverSourceScope,
  mode: SourceVisibilityMode,
): { sourceBadges: WorkCardBadge[]; sourceUnavailableFallback: boolean } {
  if (mode === "always") return { sourceBadges: badges, sourceUnavailableFallback: true };
  if (mode === "never") return { sourceBadges: [], sourceUnavailableFallback: false };
  const sourceBadges = badges.filter((badge) => !hiddenAutomatically(badge, scope));
  // An originally empty list still reports the missing source, which is itself an exception.
  return { sourceBadges, sourceUnavailableFallback: badges.length === 0 };
}

export function readLibraryCoverSourceMode(scope: string): SourceVisibilityMode {
  try {
    const value = window.localStorage.getItem(`${storagePrefix}${scope}`);
    return value === "always" || value === "never" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeLibraryCoverSourceMode(scope: string, mode: SourceVisibilityMode) {
  try {
    if (mode === "auto") window.localStorage.removeItem(`${storagePrefix}${scope}`);
    else window.localStorage.setItem(`${storagePrefix}${scope}`, mode);
  } catch {
    // Cards keep the automatic marks when local storage is unavailable.
  }
}

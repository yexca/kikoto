import type { SourceVisibilityMode } from "@/components/source-visibility/sourceVisibility";
import type { WorkCardBadge } from "@/components/work-card/WorkCardShell";
import { accountScopeKey, localStore } from "@/lib/clientStorage";

export type LibraryCoverSourceScope = { kind: "local" } | { kind: "tracked" } | { kind: "remote"; sourceId: number };

const storageName = "kikoto:library-cover-sources";

// A remote catalog presence (`source:<id>`) says another service lists the work;
// it is not a state of the library, so it is never an exception on any scope.
const remoteCatalogKey = /^source:\d+$/;

function hiddenAutomatically(badge: WorkCardBadge, scope: LibraryCoverSourceScope) {
  const key = badge.key ?? "";
  if (remoteCatalogKey.test(key)) return true;
  if (badge.variant === "warning") return false;
  if (scope.kind === "local") return key === "source:local";
  if (scope.kind === "tracked") return key.startsWith("source:tracked");
  return key === `source:remote:${scope.sourceId}`;
}

/**
 * Cover source marks for a Library card. Automatic mode drops the healthy mark
 * the current Library scope already implies and remote catalog listings, so
 * only exceptions remain (a warning about the work's own files, or another
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

/** `storageScope` is the account storage scope; the mode is kept per server and account. */
export function readLibraryCoverSourceMode(storageScope: string): SourceVisibilityMode {
  const value = localStore.read(accountScopeKey(storageName, storageScope));
  return value === "always" || value === "never" ? value : "auto";
}

// Cards keep the automatic marks when local storage is unavailable.
export function writeLibraryCoverSourceMode(storageScope: string, mode: SourceVisibilityMode) {
  const key = accountScopeKey(storageName, storageScope);
  if (mode === "auto") localStore.remove(key);
  else localStore.write(key, mode);
}

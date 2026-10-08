import {
  readSourceVisibility,
  writeSourceVisibility,
  type SourceVisibilityKey,
  type SourceVisibilityPreferences,
} from "@/components/source-visibility/sourceVisibility";
import type { LibrarySource } from "@/lib/api";

const storagePrefix = "kikoto:library-source-visibility:";

/**
 * Automatic visibility: Local is always shown, Tracked is shown once any tracked
 * work exists (null while unknown), and a remote source is shown while enabled.
 */
export function autoLibrarySourceVisible(
  key: SourceVisibilityKey,
  context: { hasTrackedWorks: boolean | null; source?: LibrarySource },
) {
  if (key === "local") return true;
  if (key === "tracked") return context.hasTrackedWorks === true;
  return context.source?.enabled === true;
}

export function readLibrarySourceVisibility(scope: string): SourceVisibilityPreferences {
  return readSourceVisibility(`${storagePrefix}${scope}`);
}

export function writeLibrarySourceVisibility(scope: string, preferences: SourceVisibilityPreferences) {
  writeSourceVisibility(`${storagePrefix}${scope}`, preferences);
}

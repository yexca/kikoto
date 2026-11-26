import type { LibrarySort, SortDirection } from "@/lib/libraryApi";
import { accountScopeKey, localStore } from "@/lib/clientStorage";

/** The orders a creator's works offer: the Library orders that need no seed or account history. */
export const creatorWorkSortValues = [
  "release",
  "code",
  "title",
  "rating",
  "sales",
] as const satisfies readonly LibrarySort[];
export type CreatorWorkSort = (typeof creatorWorkSortValues)[number];

export const creatorWorkPageSizeOptions = [24, 48, 96] as const;
export type CreatorWorkPageSize = (typeof creatorWorkPageSizeOptions)[number];

export type CreatorWorksBrowse = {
  sort: CreatorWorkSort;
  direction: SortDirection;
  pageSize: CreatorWorkPageSize;
};

export const defaultCreatorWorksBrowse: CreatorWorksBrowse = { sort: "release", direction: "desc", pageSize: 24 };

/** Circle catalogs and voice actor works each keep their own choice. */
export type CreatorWorksKind = "circle" | "voice";

const storageNames: Record<CreatorWorksKind, string> = {
  circle: "kikoto:circle-works-browse",
  voice: "kikoto:voice-works-browse",
};

/** Keeps each valid stored field and defaults the rest. */
export function creatorWorksBrowseFromValue(value: unknown): CreatorWorksBrowse {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<
    Record<keyof CreatorWorksBrowse, unknown>
  >;
  return {
    sort: creatorWorkSortValues.find((option) => option === stored.sort) ?? defaultCreatorWorksBrowse.sort,
    direction: stored.direction === "asc" || stored.direction === "desc" ? stored.direction : "desc",
    pageSize:
      creatorWorkPageSizeOptions.find((option) => option === stored.pageSize) ?? defaultCreatorWorksBrowse.pageSize,
  };
}

/** The order and page size chosen for one kind of creator, kept per server and account on this device. */
export function readCreatorWorksBrowse(kind: CreatorWorksKind, storageScope: string): CreatorWorksBrowse {
  return creatorWorksBrowseFromValue(localStore.readJSON(accountScopeKey(storageNames[kind], storageScope)));
}

// The choice still applies to this visit when storage is unavailable.
export function writeCreatorWorksBrowse(kind: CreatorWorksKind, storageScope: string, browse: CreatorWorksBrowse) {
  localStore.writeJSON(accountScopeKey(storageNames[kind], storageScope), browse);
}

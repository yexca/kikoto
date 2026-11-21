import type { LocalWorkCleanupRequest, LocalWorkCleanupWork } from "@/lib/api";

/** Works rated this many stars or more need a second confirmation before their files are deleted. */
export const highRatingThreshold = 3;

export type LocalWorkCleanupOptions = {
  clearRating: boolean;
  clearMark: boolean;
  forget: boolean;
};

export const defaultLocalWorkCleanupOptions: LocalWorkCleanupOptions = {
  clearRating: false,
  clearMark: false,
  forget: false,
};

/**
 * Forgetting a work removes everything Kikoto knows about it, so it is offered
 * only while both the rating and the Quick mark are cleared too, and turning
 * either of them off turns forgetting off.
 */
export function setLocalWorkCleanupOption(
  options: LocalWorkCleanupOptions,
  key: keyof LocalWorkCleanupOptions,
  checked: boolean,
): LocalWorkCleanupOptions {
  const next = { ...options, [key]: checked };
  if (key === "forget" && checked && !(next.clearRating && next.clearMark)) return options;
  if (!next.clearRating || !next.clearMark) next.forget = false;
  return next;
}

export function canForgetWorks(options: LocalWorkCleanupOptions) {
  return options.clearRating && options.clearMark;
}

export function highRatedWorks(works: readonly LocalWorkCleanupWork[]) {
  return works.filter((work) => work.rating !== null && work.rating >= highRatingThreshold);
}

export function unratedWorkCount(works: readonly LocalWorkCleanupWork[]) {
  return works.filter((work) => work.rating === null).length;
}

/**
 * The recorded size of the works' files. It is incomplete while a work has
 * files without a recorded size or has not been indexed yet, which the
 * deletion indexes first.
 */
export function selectionSize(works: readonly LocalWorkCleanupWork[]) {
  return {
    bytes: works.reduce((total, work) => total + work.sizeBytes, 0),
    complete: works.every((work) => work.fileCount > 0 && work.unknownSizeFiles === 0),
  };
}

/**
 * Keeps a selection in step with a freshly loaded page: a selected work that
 * is now offline leaves it, and the others take their latest folders, rating,
 * and size, so a confirmation never sends what the list no longer shows.
 */
export function reconcileSelection(
  selected: ReadonlyMap<number, LocalWorkCleanupWork>,
  works: readonly LocalWorkCleanupWork[],
): ReadonlyMap<number, LocalWorkCleanupWork> {
  if (!works.some((work) => selected.has(work.workId))) return selected;
  const next = new Map(selected);
  for (const work of works) {
    if (!next.has(work.workId)) continue;
    if (work.offline) next.delete(work.workId);
    else next.set(work.workId, work);
  }
  return next;
}

/**
 * The page a reloaded list shows: the requested page while it still exists,
 * otherwise the last page left, or the first when the list is empty.
 */
export function availableCleanupPage(page: number, total: number, pageSize: number) {
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

/** Works another source still provides, which forgetting keeps. */
export function retainedWorkCount(works: readonly LocalWorkCleanupWork[]) {
  return works.filter((work) => work.sourceAvailable).length;
}

export function localWorkCleanupRequest(
  works: readonly LocalWorkCleanupWork[],
  options: LocalWorkCleanupOptions,
  confirmHighRated: boolean,
): LocalWorkCleanupRequest {
  return {
    works: works.map((work) => ({
      workId: work.workId,
      folders: work.folders.map((folder) => ({ id: folder.id, path: folder.path })),
    })),
    clearRating: options.clearRating,
    clearMark: options.clearMark,
    forget: options.forget && canForgetWorks(options),
    confirmHighRated,
  };
}

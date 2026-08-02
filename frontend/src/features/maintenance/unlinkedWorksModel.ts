export type CurrentPageSelection = {
  checked: boolean;
  indeterminate: boolean;
  selectedCount: number;
};

export function currentPageSelection(pageWorkIds: number[], selectedWorkIds: ReadonlySet<number>): CurrentPageSelection {
  const selectedCount = pageWorkIds.reduce((count, workId) => count + (selectedWorkIds.has(workId) ? 1 : 0), 0);
  return {
    checked: pageWorkIds.length > 0 && selectedCount === pageWorkIds.length,
    indeterminate: selectedCount > 0 && selectedCount < pageWorkIds.length,
    selectedCount,
  };
}

export function setCurrentPageSelected(pageWorkIds: number[], selectedWorkIds: ReadonlySet<number>, selected: boolean) {
  const next = new Set(selectedWorkIds);
  for (const workId of pageWorkIds) {
    if (selected) next.add(workId);
    else next.delete(workId);
  }
  return next;
}

export function pageAfterUnlinkedDelete(page: number, total: number, pageSize: number, deletedFamilies: number) {
  const remaining = Math.max(0, total - Math.max(0, deletedFamilies));
  const lastPage = Math.max(1, Math.ceil(remaining / Math.max(1, pageSize)));
  return Math.min(Math.max(1, page), lastPage);
}

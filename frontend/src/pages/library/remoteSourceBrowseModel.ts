import type { RemoteWork, RemoteWorkEdition, RemoteWorksResponse } from "@/lib/api";

import type { RemoteSourceViewState } from "./libraryBrowseModel";

const emptyRemoteWorks: RemoteWork[] = [];

type RemoteSourceBrowseModel = {
  visibleWorks: RemoteWork[];
  selectableWorks: RemoteWork[];
  totalItems: number;
  totalPages: number;
  currentPage: number;
  remotePaginationProps: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    onPageChange: (page: number) => void;
  };
  remoteError: NonNullable<RemoteWorksResponse["error"]> | null;
};

type RemoteSourcePanelModel = RemoteSourceBrowseModel & {
  selectedWorks: RemoteWork[];
  selectedSyncable: RemoteWork[];
  selectedSaveable: RemoteWork[];
};

type RemoteSourceBrowseInput = {
  result: RemoteWorksResponse | null;
  viewState: RemoteSourceViewState;
  onPageChange: (page: number) => void;
};

export function remoteSourceBrowseModel({
  result,
  viewState,
  onPageChange,
}: RemoteSourceBrowseInput): RemoteSourceBrowseModel {
  const { page, pageSize } = viewState;
  const visibleWorks = result?.works ?? emptyRemoteWorks;
  const selectableWorks = visibleWorks.filter((work) => work.primaryCode);
  const totalItems = result?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  return {
    visibleWorks,
    selectableWorks,
    totalItems,
    totalPages,
    currentPage,
    remotePaginationProps: { page: currentPage, pageSize, totalItems, totalPages, onPageChange },
    remoteError:
      result?.error ??
      (result?.status === "disabled"
        ? { code: "disabled", message: "", retryable: false }
        : result?.status === "unavailable"
          ? { code: "unavailable", message: "", retryable: true }
          : null),
  };
}

export function remoteSourcePanelModel({
  browse,
  bulkCodes,
}: {
  browse: RemoteSourceBrowseModel;
  bulkCodes: Set<string>;
}): RemoteSourcePanelModel {
  const selectedWorks = browse.selectableWorks.filter((work) => bulkCodes.has(work.primaryCode));
  return {
    ...browse,
    selectedWorks,
    selectedSyncable: selectedWorks.filter((work) => work.workId === null),
    selectedSaveable: selectedWorks,
  };
}

export function remoteWorkActionCode(work: RemoteWork) {
  return work.remoteCode || work.primaryCode || work.remoteId;
}

/** The folded editions a card offers, or none when the source returned only the presented one. */
export function remoteWorkEditionChoices(work: RemoteWork): RemoteWorkEdition[] {
  return work.editions.length > 1 ? work.editions : [];
}

export function remoteWorkPresentsEdition(work: RemoteWork, edition: RemoteWorkEdition) {
  return edition.remoteId === work.remoteId && edition.remoteCode.toUpperCase() === work.remoteCode.toUpperCase();
}

/** The card's work as one folded edition, for opening that edition's source page. */
export function remoteWorkForEdition(work: RemoteWork, edition: RemoteWorkEdition): RemoteWork {
  return { ...work, remoteId: edition.remoteId, remoteCode: edition.remoteCode, title: edition.title || work.title };
}

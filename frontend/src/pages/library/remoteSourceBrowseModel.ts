import type { RemoteWork, RemoteWorksResponse } from "@/lib/api";

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

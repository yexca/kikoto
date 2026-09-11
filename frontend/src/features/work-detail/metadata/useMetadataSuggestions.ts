import { useEffect, useState } from "react";

import { toastFromError, useToast } from "@/components/ui/toast";

import { api, type WorkCoverCandidate } from "@/lib/api";

import i18n from "@/i18n";

type SuggestionResult<T> = {
  items: T[];
  truncated: boolean;
};

export type DebouncedSuggestionResult<T> = SuggestionResult<T> & {
  clear: () => void;
};

function emptySuggestionResult<T>(): SuggestionResult<T> {
  return { items: [], truncated: false };
}

export function useDebouncedSuggestion<T>(
  query: string,
  requestKey: string,
  request: () => Promise<SuggestionResult<T>>,
): DebouncedSuggestionResult<T> {
  const [state, setState] = useState<{ key: string; result: SuggestionResult<T> }>(() => ({
    key: requestKey,
    result: emptySuggestionResult<T>(),
  }));

  useEffect(() => {
    if ([...query].length < 2) {
      setState({ key: requestKey, result: emptySuggestionResult<T>() });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      request()
        .then((next) => {
          if (!cancelled) setState({ key: requestKey, result: next });
        })
        .catch(() => {
          if (!cancelled) setState({ key: requestKey, result: emptySuggestionResult<T>() });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, requestKey]);

  const result = state.key === requestKey ? state.result : emptySuggestionResult<T>();
  return {
    ...result,
    clear: () => setState({ key: requestKey, result: emptySuggestionResult<T>() }),
  };
}

export function useWorkCoverCandidates(workId: number, toast: ReturnType<typeof useToast>) {
  const [coverCandidates, setCoverCandidates] = useState<WorkCoverCandidate[]>([]);
  const [selectedCoverId, setSelectedCoverId] = useState<number | null>(null);
  const [loadingCovers, setLoadingCovers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingCovers(true);
    api
      .listWorkCoverCandidates(workId)
      .then((result) => {
        if (cancelled) return;
        setCoverCandidates(result.candidates);
        setSelectedCoverId(result.candidates.find((candidate) => candidate.selected)?.locationId ?? null);
      })
      .catch((error) => {
        if (!cancelled) toast.notify(toastFromError(error, i18n.t("libraryDetail.coverCandidatesLoadFailed")));
      })
      .finally(() => {
        if (!cancelled) setLoadingCovers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, workId]);

  return { coverCandidates, selectedCoverId, setSelectedCoverId, loadingCovers };
}

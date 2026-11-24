import { useEffect, useState } from "react";

import { toastFromError, useToast } from "@/components/ui/toast";
import { useStableCallback } from "@/hooks/useStableCallback";

import { api, type WorkCoverCandidate } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

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
  // Callers pass an inline request; requestKey identifies what it asks for.
  const runRequest = useStableCallback(request);

  useEffect(() => {
    if ([...query].length < 2) {
      setState({ key: requestKey, result: emptySuggestionResult<T>() });
      return;
    }
    return startLoad(
      () => runRequest(),
      {
        onSuccess: (next) => setState({ key: requestKey, result: next }),
        onError: () => setState({ key: requestKey, result: emptySuggestionResult<T>() }),
      },
      { delayMs: 250 },
    );
  }, [query, requestKey, runRequest]);

  const result = state.key === requestKey ? state.result : emptySuggestionResult<T>();
  return {
    ...result,
    clear: () => setState({ key: requestKey, result: emptySuggestionResult<T>() }),
  };
}

export function useWorkCoverCandidates(workId: number, toast: ReturnType<typeof useToast>) {
  const [coverCandidates, setCoverCandidates] = useState<WorkCoverCandidate[]>([]);
  const [providerCoverUrl, setProviderCoverUrl] = useState("");
  const [selectedCoverId, setSelectedCoverId] = useState<number | null>(null);
  const [initialCoverId, setInitialCoverId] = useState<number | null>(null);
  const [loadingCovers, setLoadingCovers] = useState(false);

  useEffect(() => {
    setLoadingCovers(true);
    return startLoad(() => api.listWorkCoverCandidates(workId), {
      onSuccess: (result) => {
        setCoverCandidates(result.candidates);
        setProviderCoverUrl(result.providerCoverUrl ?? "");
        const selected = result.candidates.find((candidate) => candidate.selected)?.locationId ?? null;
        setSelectedCoverId(selected);
        setInitialCoverId(selected);
      },
      onError: (error) => toast.notify(toastFromError(error, i18n.t("libraryDetail.coverCandidatesLoadFailed"))),
      onSettled: () => setLoadingCovers(false),
    });
  }, [toast, workId]);

  return { coverCandidates, providerCoverUrl, selectedCoverId, setSelectedCoverId, initialCoverId, loadingCovers };
}

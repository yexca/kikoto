import { type Dispatch, type RefObject, type SetStateAction, useEffect, useState } from "react";

import { workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import { loadWorkDetailStages } from "@/features/work-detail/loadWorkDetailStages";
import {
  getCachedWorkMedia,
  invalidateCachedWorkMedia,
  setCachedWorkMedia,
} from "@/features/work-detail/media/workMediaCache";
import { directoryLoadErrorMessage, type WorkPreview } from "@/features/work-detail/workDetailShared";
import { api, type Work, type WorkDetail } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import { workLoadFailure, type WorkLoadFailure } from "./workLoadFailure";
import { workPreviewFromHistory } from "./workPreviewHistory";

async function resolveAndOpenWork(
  code: string,
  principalID: ClientPrincipalID,
  setSelectedWork: Dispatch<SetStateAction<WorkDetail | null>>,
  setSelectedWorkPreview: (work: WorkPreview | null) => void,
  setSelectedCode: (code: string | null) => void,
  setMediaLoading: (loading: boolean) => void,
  setLoadFailure: (failure: WorkLoadFailure | null) => void,
  setMediaError: (message: string) => void,
  signal: AbortSignal,
) {
  try {
    setMediaLoading(true);
    setLoadFailure(null);
    setMediaError("");
    let resolvedCode = code;
    let resolvedID: number | null = null;
    await loadWorkDetailStages(
      code,
      principalID,
      signal,
      (work) => {
        resolvedCode = work.primaryCode;
        resolvedID = work.id;
        setSelectedWorkPreview(work);
        setSelectedWork(work);
      },
      (mediaItems) => setSelectedWork((current) => (current?.id === resolvedID ? { ...current, mediaItems } : current)),
      (error) => setMediaError(directoryLoadErrorMessage(error)),
    );
    if (signal.aborted) return;
    if (
      resolvedCode &&
      resolvedCode.toUpperCase() !== code.toUpperCase() &&
      workDetailCodeFromLocation(window.location.pathname, window.location.search)?.toUpperCase() === code.toUpperCase()
    ) {
      window.history.replaceState(window.history.state ?? {}, "", `/${resolvedCode}${window.location.search}`);
      setSelectedCode(resolvedCode);
      window.dispatchEvent(new Event("kikoto:navigation"));
    }
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    setSelectedWork(null);
    setLoadFailure(workLoadFailure(error));
  } finally {
    if (!signal?.aborted) setMediaLoading(false);
  }
}

/**
 * Loads the work selected by the Library route: its summary first, then its
 * media directory, so a directory failure keeps the rendered summary.
 * `listedWorksRef` supplies a known work id and preview for a code opened
 * from the list.
 */
export function useLibraryWorkDetail({
  active,
  principalID,
  selectedCode,
  onCodeResolved,
  listedWorksRef,
  listedWorkCount,
}: {
  active: boolean;
  principalID: ClientPrincipalID;
  selectedCode: string | null;
  /** The selected code names another edition of the work that was loaded. */
  onCodeResolved: (code: string | null) => void;
  listedWorksRef: RefObject<Work[]>;
  listedWorkCount: number;
}) {
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [loadFailure, setLoadFailure] = useState<WorkLoadFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [preview, setPreview] = useState<WorkPreview | null>(() =>
    workPreviewFromHistory(workDetailCodeFromLocation(window.location.pathname, window.location.search)),
  );
  const [mediaLoading, setMediaLoading] = useState(false);
  const [mediaError, setMediaError] = useState("");

  useEffect(() => {
    if (!active) return;
    if (selectedCode === null) {
      setWork(null);
      setLoadFailure(null);
      setMediaLoading(false);
      setMediaError("");
      return;
    }
    setLoadFailure(null);
    setMediaError("");
    const controller = new AbortController();
    const listedWork = listedWorksRef.current.find(
      (item) => item.primaryCode.toUpperCase() === selectedCode.toUpperCase(),
    );
    const historyPreview = workPreviewFromHistory(selectedCode);
    const workID = listedWork?.id ?? historyPreview?.id ?? null;
    setPreview(listedWork ?? historyPreview);
    if (workID !== null) {
      setMediaLoading(true);
      void loadWorkDetailStages(
        workID,
        principalID,
        controller.signal,
        setWork,
        (mediaItems) => setWork((current) => (current?.id === workID ? { ...current, mediaItems } : current)),
        (error) => setMediaError(directoryLoadErrorMessage(error)),
        () =>
          resolveAndOpenWork(
            selectedCode,
            principalID,
            setWork,
            setPreview,
            onCodeResolved,
            setMediaLoading,
            setLoadFailure,
            setMediaError,
            controller.signal,
          ),
      )
        .catch((error) => {
          if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
            setWork(null);
            setLoadFailure(workLoadFailure(error));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setMediaLoading(false);
        });
      return () => controller.abort();
    }
    void resolveAndOpenWork(
      selectedCode,
      principalID,
      setWork,
      setPreview,
      onCodeResolved,
      setMediaLoading,
      setLoadFailure,
      setMediaError,
      controller.signal,
    );
    return () => controller.abort();
  }, [active, principalID, selectedCode, loadAttempt, listedWorkCount, listedWorksRef, onCodeResolved]);

  const reload = async (workID: number, includeMedia = false) => {
    const detail = await api.getWorkSummary(workID);
    let mediaItems = getCachedWorkMedia(workID, principalID) ?? (work?.id === workID ? work.mediaItems : []);
    if (includeMedia) {
      invalidateCachedWorkMedia(workID, principalID);
      const media = await api.getWorkMedia(workID);
      mediaItems = media.mediaItems;
      setCachedWorkMedia(workID, principalID, mediaItems);
    }
    setWork({ ...detail, mediaItems });
  };

  const patchWork = (workID: number, patch: Partial<WorkDetail>) => {
    setWork((item) => (item?.id === workID ? { ...item, ...patch } : item));
  };

  return {
    work,
    preview,
    setPreview,
    loadFailure,
    clearLoadFailure: () => setLoadFailure(null),
    retry: () => setLoadAttempt((attempt) => attempt + 1),
    mediaLoading,
    mediaError,
    reload,
    patchWork,
  };
}

export type LibraryWorkDetailState = ReturnType<typeof useLibraryWorkDetail>;

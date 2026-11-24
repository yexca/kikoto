import { useEffect, useState } from "react";

import { api, type WorkDetail } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { useLatestLoad } from "@/hooks/useLatestLoad";
import { useStableCallback } from "@/hooks/useStableCallback";
import { setCachedWorkMedia } from "@/features/work-detail/media/workMediaCache";
import { directoryLoadErrorMessage } from "@/features/work-detail/workDetailShared";
import { workVersionAvailableForScope } from "@/features/work-detail/workVersionModel";

type WorkEdition = WorkDetail["translations"][number];

/**
 * Owns which language edition of a persisted work supplies the local
 * directory. The opened work is the default; another edition loads on demand,
 * and only the latest request may publish its result. A work whose own edition
 * has no local files opens on its first locally available edition.
 */
export function useWorkEditionSelection({
  work,
  principalID,
  onSelectionStart,
  onLocalEditionSelected,
}: {
  work: WorkDetail | null;
  principalID: ClientPrincipalID;
  /** Runs before every edition selection, including the automatic one. */
  onSelectionStart: () => void;
  /** Runs when a selected edition is ready to show from the local source. */
  onLocalEditionSelected: () => void;
}) {
  const [activeEdition, setActiveEdition] = useState<WorkDetail | null>(null);
  const [activeEditionCode, setActiveEditionCode] = useState("");
  const [editionLoadingCode, setEditionLoadingCode] = useState("");
  const [editionError, setEditionError] = useState("");
  const [editionErrorCode, setEditionErrorCode] = useState("");
  const editionLoad = useLatestLoad();

  useEffect(() => {
    editionLoad.cancel();
    setActiveEdition(null);
    setActiveEditionCode("");
    setEditionLoadingCode("");
    setEditionError("");
    setEditionErrorCode("");
    return editionLoad.cancel;
  }, [editionLoad, principalID, work?.id]);

  const selectEdition = useStableCallback(async (translation: WorkEdition) => {
    const editionWorkId = translation.workId;
    if (!editionWorkId || !work) return;
    onSelectionStart();
    editionLoad.cancel();
    setEditionError("");
    setEditionErrorCode("");
    if (editionWorkId === work.id) {
      setEditionLoadingCode("");
      setActiveEdition(null);
      setActiveEditionCode(translation.primaryCode);
      onLocalEditionSelected();
      return;
    }
    setEditionLoadingCode(translation.primaryCode);
    await editionLoad.run((signal) => api.getWork(editionWorkId, signal), {
      onSuccess: (detail) => {
        setCachedWorkMedia(detail.id, principalID, detail.mediaItems);
        setActiveEdition(detail);
        setActiveEditionCode(detail.primaryCode);
        onLocalEditionSelected();
      },
      onError: (error) => {
        // A session change cancels the read without failing the edition.
        if (error instanceof DOMException && error.name === "AbortError") return;
        setEditionError(directoryLoadErrorMessage(error));
        setEditionErrorCode(translation.primaryCode);
      },
      onSettled: () => setEditionLoadingCode(""),
    });
  });

  useEffect(() => {
    if (!work || activeEditionCode) return;
    const translations = work.translations ?? [];
    const currentVersion = translations.find(
      (translation) => translation.primaryCode.toUpperCase() === work.primaryCode.toUpperCase(),
    );
    if (currentVersion && workVersionAvailableForScope(currentVersion, "local")) return;
    const firstPlayableVersion = translations.find(
      (translation) => translation.workId && workVersionAvailableForScope(translation, "local"),
    );
    if (firstPlayableVersion) {
      void selectEdition(firstPlayableVersion);
    }
  }, [activeEditionCode, selectEdition, work]);

  /** Shows an already loaded edition and marks it as the active version. */
  const showEdition = (detail: WorkDetail) => {
    setActiveEdition(detail);
    setActiveEditionCode(detail.primaryCode);
  };

  /**
   * Loads an edition by its work id and shows it, as Resume does for the
   * edition its cursor plays from. Only the latest request may publish, and a
   * failed load keeps the shown edition.
   */
  const showEditionById = useStableCallback(async (editionWorkId: number) => {
    if (!work) return;
    editionLoad.cancel();
    if (editionWorkId === work.id) {
      setActiveEdition(null);
      setActiveEditionCode(work.primaryCode);
      return;
    }
    // A failure keeps the edition the directory shows.
    await editionLoad.run((signal) => api.getWork(editionWorkId, signal), {
      onSuccess: (detail) => {
        setCachedWorkMedia(detail.id, principalID, detail.mediaItems);
        showEdition(detail);
      },
    });
  });

  /** Returns to the opened work's own edition, as a non-local source requires. */
  const resetToWorkEdition = () => {
    setActiveEdition(null);
    setActiveEditionCode(work?.primaryCode ?? "");
  };

  /** Reloads the edition whose load failed; false when no edition load failed. */
  const retryFailedEdition = () => {
    const failedEdition = (work?.translations ?? []).find(
      (translation) => translation.primaryCode.toUpperCase() === editionErrorCode.toUpperCase(),
    );
    if (!failedEdition) return false;
    void selectEdition(failedEdition);
    return true;
  };

  return {
    activeEdition,
    activeEditionCode,
    editionLoadingCode,
    editionError,
    selectEdition,
    showEdition,
    showEditionById,
    /** Replaces the active edition's record after its files changed. */
    replaceActiveEdition: setActiveEdition,
    /** Marks the version a remote source is showing; no local edition loads. */
    setActiveEditionCode,
    resetToWorkEdition,
    retryFailedEdition,
  };
}

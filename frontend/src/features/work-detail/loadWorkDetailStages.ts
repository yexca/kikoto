import { api, type WorkDetail } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { getCachedWorkMedia, setCachedWorkMedia } from "./media/workMediaCache";

// Start both reads together. A directory failure keeps the rendered summary;
// an edition redirect cancels the speculative directory before resolving it.
export async function loadWorkDetailStages(
  workID: number | string,
  principalID: ClientPrincipalID,
  signal: AbortSignal,
  onSummary: (work: WorkDetail) => void,
  onMedia: (mediaItems: WorkDetail["mediaItems"]) => void,
  onMediaError: (error: unknown) => void,
  onTranslation?: () => Promise<void>,
) {
  const mediaController = new AbortController();
  const abortMedia = () => mediaController.abort();
  signal.addEventListener("abort", abortMedia, { once: true });
  if (signal.aborted) abortMedia();
  const cached = typeof workID === "number" ? getCachedWorkMedia(workID, principalID) : null;
  const mediaResult = cached
    ? Promise.resolve({ workId: workID, mediaItems: cached })
    : api.getWorkMedia(workID, mediaController.signal).then(
        (media) => ({ workId: media.workId, mediaItems: media.mediaItems }),
        (error: unknown) => ({ error }),
      );
  try {
    const work = await api.getWorkSummary(workID, signal);
    if (signal.aborted) return;
    if (onTranslation && work.baseCode && work.baseCode.toUpperCase() !== work.primaryCode.toUpperCase()) {
      abortMedia();
      await onTranslation();
      return;
    }
    onSummary({ ...work, mediaItems: cached ?? [] });
    let media = await mediaResult;
    if (signal.aborted) return;
    // An alias/family can change between the two reads. Keep the rendered
    // summary and re-read its exact numeric identity once instead of mixing them.
    if (!("error" in media) && media.workId !== work.id) {
      media = await api.getWorkMedia(work.id, mediaController.signal).then(
        (result) => ({ workId: result.workId, mediaItems: result.mediaItems }),
        (error: unknown) => ({ error }),
      );
      if (signal.aborted) return;
    }
    if ("error" in media) onMediaError(media.error);
    else {
      if (!cached) setCachedWorkMedia(work.id, principalID, media.mediaItems);
      onMedia(media.mediaItems);
    }
  } finally {
    signal.removeEventListener("abort", abortMedia);
    abortMedia();
  }
}

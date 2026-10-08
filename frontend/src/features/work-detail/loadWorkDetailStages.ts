import { api, type WorkDetail } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";
import { getCachedWorkMedia, setCachedWorkMedia } from "./media/workMediaCache";

// Start both reads together. A directory failure keeps the rendered summary;
// an edition redirect cancels the speculative directory before resolving it.
export async function loadWorkDetailStages(
  workID: number,
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
  const cached = getCachedWorkMedia(workID, principalID);
  const mediaResult = cached
    ? Promise.resolve({ mediaItems: cached })
    : api.getWorkMedia(workID, mediaController.signal).then(
        (media) => ({ mediaItems: media.mediaItems }),
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
    const media = await mediaResult;
    if (signal.aborted) return;
    if ("error" in media) onMediaError(media.error);
    else {
      if (!cached) setCachedWorkMedia(workID, principalID, media.mediaItems);
      onMedia(media.mediaItems);
    }
  } finally {
    signal.removeEventListener("abort", abortMedia);
    abortMedia();
  }
}

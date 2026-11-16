import type Hls from "hls.js";
import type { ErrorData } from "hls.js";

import { assetURL, type VideoPlaybackInfo } from "@/lib/api";

import { prefersNativeVideoHls } from "./mediaPlayback";
import { CONSERVATIVE_HLS_CONFIG, retriesRemuxAsTranscode } from "./videoPlaybackModel";

/**
 * Why a playback source stopped: a remux the browser cannot decode asks for a
 * transcode; the others are shown to the viewer.
 */
export type PlaybackSourceFailure = "transcode" | "busy" | "playFailed" | "hlsUnsupported" | "playerLoadFailed";

/**
 * Plays a source that playback info chose in a media element: a direct file,
 * or HLS natively where the browser prefers it and through hls.js otherwise.
 * hls.js starts loading at `startPosition`; a direct file starts wherever the
 * caller seeks once its metadata loads. Returns the cleanup that detaches the
 * source.
 */
export function attachPlaybackSource(
  media: HTMLMediaElement,
  playback: Pick<VideoPlaybackInfo, "delivery" | "conversion" | "url">,
  { startPosition, onFailure }: { startPosition?: number; onFailure: (failure: PlaybackSourceFailure) => void },
): () => void {
  let active = true;
  let instance: Hls | null = null;
  const url = assetURL(playback.url);
  const clear = () => {
    media.removeAttribute("src");
    media.load();
  };
  // iOS and iPadOS play HLS natively, which keeps native fullscreen and AirPlay.
  if (playback.delivery === "direct" || prefersNativeVideoHls(media)) {
    media.src = url;
    return () => {
      active = false;
      clear();
    };
  }
  void import("hls.js")
    .then(({ default: HlsConstructor }) => {
      if (!active) return;
      if (!HlsConstructor.isSupported()) {
        if (media.canPlayType("application/vnd.apple.mpegurl")) media.src = url;
        else onFailure("hlsUnsupported");
        return;
      }
      let mediaRecoveryAttempts = 0;
      const hls = new HlsConstructor({ ...CONSERVATIVE_HLS_CONFIG, startPosition: startPosition ?? -1 });
      instance = hls;
      hls.on(HlsConstructor.Events.ERROR, (_event: string, data: ErrorData) => {
        if (!data.fatal || !active) return;
        if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 1) {
          mediaRecoveryAttempts++;
          hls.recoverMediaError();
          return;
        }
        hls.stopLoad();
        if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && retriesRemuxAsTranscode(playback)) {
          onFailure("transcode");
          return;
        }
        onFailure(data.response?.code === 503 || data.response?.code === 429 ? "busy" : "playFailed");
      });
      hls.loadSource(url);
      hls.attachMedia(media);
    })
    .catch(() => {
      if (active) onFailure("playerLoadFailed");
    });
  return () => {
    active = false;
    instance?.destroy();
    clear();
  };
}

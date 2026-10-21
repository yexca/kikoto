import type Hls from "hls.js";
import type { ErrorData, HlsConfig } from "hls.js";

import type { AudioHlsPlayback } from "./mediaPlayback";

/** About a minute of 192 kbit/s audio ahead; the server encodes well past it. */
export const AUDIO_HLS_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  lowLatencyMode: false,
  // Loading starts once the playlist is known, at the track's start position.
  autoStartLoad: false,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 60,
  maxBufferSize: 8 * 1024 * 1024,
  fragLoadingTimeOut: 60_000,
  manifestLoadingTimeOut: 30_000,
  fragLoadingMaxRetry: 4,
  manifestLoadingMaxRetry: 2,
};

/**
 * Plays an audio HLS playlist in the element, natively or through hls.js. A
 * resumed track loads the segment its start position falls in rather than the
 * first one, so the server does not convert the beginning first. A failure
 * hls.js cannot recover from is reported through onFatalError, since it does
 * not always reach the element as an error event. hls.js gives the element its
 * source only after it loads, which aborts a play request made before; the
 * caller asks again in onAttached. Returns the detach function.
 */
export function attachAudioHls(
  audio: HTMLAudioElement,
  url: string,
  playback: AudioHlsPlayback,
  {
    startPosition,
    onAttached,
    onFatalError,
  }: { startPosition: () => number; onAttached: () => void; onFatalError: () => void },
): () => void {
  if (playback === "native") {
    audio.src = url;
    audio.load();
    return () => {};
  }
  let active = true;
  let instance: Hls | null = null;
  void import("hls.js")
    .then(({ default: HlsConstructor }) => {
      if (!active) return;
      let mediaRecoveryAttempts = 0;
      const hls = new HlsConstructor(AUDIO_HLS_CONFIG);
      instance = hls;
      hls.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
        const position = startPosition();
        hls.startLoad(position > 0 && Number.isFinite(position) ? position : -1);
      });
      hls.on(HlsConstructor.Events.ERROR, (_event: string, data: ErrorData) => {
        if (!data.fatal || !active) return;
        if (data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 1) {
          mediaRecoveryAttempts++;
          hls.recoverMediaError();
          return;
        }
        hls.stopLoad();
        onFatalError();
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
      onAttached();
    })
    .catch(() => {
      if (active) onFatalError();
    });
  return () => {
    active = false;
    instance?.destroy();
    instance = null;
  };
}

/**
 * Requests a playlist and its first segment, so the server converts the start
 * of a queued track before the player reaches it.
 */
export async function warmAudioHls(url: string, signal: AbortSignal) {
  const playlistURL = new URL(url, globalThis.location?.href);
  const response = await fetch(playlistURL, { credentials: "include", signal });
  if (!response.ok) return;
  const first = (await response.text()).split("\n").find((line) => line.startsWith("segment-"));
  if (!first) return;
  const segment = await fetch(new URL(first.trim(), playlistURL), { credentials: "include", signal });
  if (segment.ok) await segment.arrayBuffer();
}

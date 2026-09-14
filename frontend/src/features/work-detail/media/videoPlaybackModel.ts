import type { HlsConfig } from "hls.js";

export async function prepareVideoPlayback<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const delays = [750, 1500];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await load();
    } catch (error) {
      if (
        signal.aborted ||
        !error ||
        typeof error !== "object" ||
        !("retryable" in error) ||
        error.retryable !== true ||
        attempt >= delays.length
      ) {
        throw error;
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          globalThis.clearTimeout(timer);
          reject(signal.reason);
        };
        const timer = globalThis.setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, delays[attempt]);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

export function videoPlaybackFailureKey(error: unknown) {
  if (error && typeof error === "object" && "status" in error && (error.status === 503 || error.status === 429)) {
    return "videoPlayback.busy";
  }
  return "videoPlayback.prepareFailed";
}

export const CONSERVATIVE_HLS_CONFIG: Partial<HlsConfig> = {
  enableWorker: true,
  lowLatencyMode: false,
  capLevelToPlayerSize: true,
  maxBufferLength: 12,
  maxMaxBufferLength: 24,
  backBufferLength: 12,
  maxBufferSize: 32 * 1024 * 1024,
  fragLoadingTimeOut: 120_000,
  manifestLoadingTimeOut: 30_000,
  fragLoadingMaxRetry: 3,
  manifestLoadingMaxRetry: 2,
};

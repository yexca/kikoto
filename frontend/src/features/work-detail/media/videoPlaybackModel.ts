import type { HlsConfig } from "hls.js";

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

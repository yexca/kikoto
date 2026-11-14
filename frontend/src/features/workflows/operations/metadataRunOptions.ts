import { metadataSyncDefaultValues, metadataSyncPayload } from "@/features/workflows/metadataSyncModel";
import type { LibrarySource, MetadataSyncOptions, RemoteMetadataFallbackSettings } from "@/lib/api";
import { currentServerScopedStorageKey } from "@/lib/clientStorageScope";

/**
 * What the Metadata card's runs use besides Full: the remote metadata
 * fallback and purchase bonus linking. A per-device convenience: new
 * Metadata triggers start from it too, and the defaults apply when storage is
 * unavailable.
 */
export type MetadataRunOptions = {
  remoteMetadataFallback: RemoteMetadataFallbackSettings;
  purchaseBonusAutoLink: boolean;
};

export const defaultMetadataRunOptions: MetadataRunOptions = {
  remoteMetadataFallback: { enabled: false, sourceIds: [] },
  purchaseBonusAutoLink: true,
};

/** The most sources one fallback asks, as the backend enforces. */
export const maxFallbackSources = 16;

const storageKey = () => currentServerScopedStorageKey("kikoto:metadata-run-options");

export function decodeMetadataRunOptions(value: unknown): MetadataRunOptions {
  if (!value || typeof value !== "object") return defaultMetadataRunOptions;
  const record = value as Record<string, unknown>;
  const fallback = (record.remoteMetadataFallback ?? {}) as Record<string, unknown>;
  const sourceIds = Array.isArray(fallback.sourceIds)
    ? [...new Set(fallback.sourceIds.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
    : [];
  return {
    remoteMetadataFallback: {
      enabled: fallback.enabled === true && sourceIds.length > 0,
      sourceIds: sourceIds.slice(0, maxFallbackSources),
    },
    purchaseBonusAutoLink: record.purchaseBonusAutoLink !== false,
  };
}

export function readMetadataRunOptions(): MetadataRunOptions {
  try {
    return decodeMetadataRunOptions(JSON.parse(window.localStorage.getItem(storageKey()) ?? "null"));
  } catch {
    return defaultMetadataRunOptions;
  }
}

export function writeMetadataRunOptions(options: MetadataRunOptions) {
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(options));
  } catch {
    // The options last for this visit when local storage is unavailable.
  }
}

/**
 * The options with fallback sources that are no longer enabled or no longer
 * provide metadata left out; a fallback left without a source is off.
 */
export function usableMetadataRunOptions(
  options: MetadataRunOptions,
  capableSources: LibrarySource[] | null,
): MetadataRunOptions {
  if (!capableSources) return options;
  const known = new Set(capableSources.map((source) => source.id));
  const sourceIds = options.remoteMetadataFallback.sourceIds.filter((id) => known.has(id));
  return {
    ...options,
    remoteMetadataFallback: { enabled: options.remoteMetadataFallback.enabled && sourceIds.length > 0, sourceIds },
  };
}

/** A Metadata card run: every work from DLsite, missing or outdated metadata unless Full. */
export function metadataRunPayload(options: MetadataRunOptions, full: boolean): MetadataSyncOptions {
  return metadataSyncPayload({
    ...metadataSyncDefaultValues(),
    mode: full ? "full" : "missing",
    remoteMetadataFallback: options.remoteMetadataFallback,
    purchaseBonusAutoLink: options.purchaseBonusAutoLink,
  });
}

/** Whether the options differ from the defaults, so the card names them. */
export function metadataRunOptionsChanged(options: MetadataRunOptions) {
  return options.remoteMetadataFallback.enabled || !options.purchaseBonusAutoLink;
}

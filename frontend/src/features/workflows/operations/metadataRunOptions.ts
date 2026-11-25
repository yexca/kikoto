import { metadataSyncDefaultValues, metadataSyncPayload } from "@/features/workflows/metadataSyncModel";
import { parseJSONRecord, workflowCopy } from "@/features/workflows/workflowPageModel";
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

const metadataRunOptionsStorageKey = () => currentServerScopedStorageKey("kikoto:metadata-run-options");

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
    return decodeMetadataRunOptions(JSON.parse(window.localStorage.getItem(metadataRunOptionsStorageKey()) ?? "null"));
  } catch {
    return defaultMetadataRunOptions;
  }
}

export function writeMetadataRunOptions(options: MetadataRunOptions) {
  try {
    window.localStorage.setItem(metadataRunOptionsStorageKey(), JSON.stringify(options));
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

/** Whether two sets of options ask the same fallback, in the same order, and the same bonus linking. */
export function sameMetadataRunOptions(left: MetadataRunOptions, right: MetadataRunOptions) {
  const fallback = (options: MetadataRunOptions) =>
    options.remoteMetadataFallback.enabled ? options.remoteMetadataFallback.sourceIds.join(",") : "";
  return fallback(left) === fallback(right) && left.purchaseBonusAutoLink === right.purchaseBonusAutoLink;
}

/** A Metadata trigger's stored fallback and bonus options. */
export function metadataRunOptionsFromConfig(configJson: string | undefined): MetadataRunOptions {
  return decodeMetadataRunOptions(parseJSONRecord(configJson ?? ""));
}

/**
 * What the options change from the defaults, in one line, as "Remote
 * fallback: A → B · Purchase bonus linking off"; null when they change nothing.
 */
export function metadataRunOptionsSummary(options: MetadataRunOptions, sources: LibrarySource[] | null) {
  if (!metadataRunOptionsChanged(options)) return null;
  const names = new Map((sources ?? []).map((source) => [source.id, source.displayName]));
  const fallback = options.remoteMetadataFallback;
  return [
    fallback.enabled
      ? workflowCopy("cards.fallbackSummary", {
          sources: fallback.sourceIds.map((id) => names.get(id) ?? `#${id}`).join(" → "),
        })
      : null,
    options.purchaseBonusAutoLink ? null : workflowCopy("cards.bonusOff"),
  ]
    .filter(Boolean)
    .join(" · ");
}

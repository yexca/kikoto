import type { LibrarySource, MetadataSyncOptions, RemoteMetadataFallbackSettings } from "@/lib/api";
import { librarySourceProvidesMetadata } from "@/lib/remoteSourceCapabilities";

/**
 * Metadata sync maintains works that already exist. The scope selects every
 * work, one circle's works, or one voice actor's works; the mode refreshes only
 * missing or stale metadata, or every selected work.
 */
export const METADATA_SYNC_SCOPES = ["all", "circle", "voice", "works"] as const;
export type MetadataSyncScope = (typeof METADATA_SYNC_SCOPES)[number];
export const METADATA_SYNC_MODES = ["missing", "full"] as const;
export type MetadataSyncMode = (typeof METADATA_SYNC_MODES)[number];

export type MetadataSyncFormValues = {
  scope: MetadataSyncScope;
  circleId: string;
  personId: string;
  /** Form-only: the picked voice actor's display name. */
  personName: string;
  mode: MetadataSyncMode;
  workCodes: string;
  sourceId: number;
  remoteMetadataFallback: RemoteMetadataFallbackSettings;
  purchaseBonusAutoLink: boolean;
};

export type MetadataSyncBlocker =
  | "circle_required"
  | "voice_required"
  | "voice_source_required"
  | "works_required"
  | "source_required"
  | "fallback_required";

const circleIdPattern = /^[RBV]G\d{5,8}$/i;

export function metadataSyncDefaultValues(): MetadataSyncFormValues {
  return {
    scope: "all",
    circleId: "",
    personId: "",
    personName: "",
    mode: "missing",
    workCodes: "",
    sourceId: 0,
    remoteMetadataFallback: { enabled: false, sourceIds: [] },
    purchaseBonusAutoLink: true,
  };
}

export function metadataSyncWorkCodes(input: string): string[] {
  return [
    ...new Set(
      input
        .toUpperCase()
        .split(/[\s,，;；]+/)
        .filter(Boolean),
    ),
  ].sort();
}

export function metadataSyncSources(sources: LibrarySource[]): LibrarySource[] {
  return sources.filter((source) => source.enabled && librarySourceProvidesMetadata(source));
}

/** A circle uses DLsite; a voice actor needs a configured remote source. */
export function metadataSyncSelectScope(
  values: MetadataSyncFormValues,
  scope: MetadataSyncScope,
  sources: LibrarySource[],
): MetadataSyncFormValues {
  const capable = metadataSyncSources(sources);
  const sourceId =
    scope === "circle"
      ? 0
      : scope === "voice" && !capable.some((source) => source.id === values.sourceId)
        ? (capable[0]?.id ?? 0)
        : values.sourceId;
  return { ...values, scope, sourceId, mode: scope === "works" ? "full" : values.mode };
}

export function metadataSyncSourceId(values: MetadataSyncFormValues): number {
  return values.scope === "circle" ? 0 : values.sourceId;
}

/** Restores form values from a stored trigger config or run input. */
export function metadataSyncValuesFromConfig(config: unknown): MetadataSyncFormValues {
  const values = metadataSyncDefaultValues();
  if (!config || typeof config !== "object" || Array.isArray(config)) return values;
  const record = config as Record<string, unknown>;
  if (METADATA_SYNC_SCOPES.includes(record.scope as MetadataSyncScope))
    values.scope = record.scope as MetadataSyncScope;
  if (METADATA_SYNC_MODES.includes(record.mode as MetadataSyncMode)) values.mode = record.mode as MetadataSyncMode;
  if (typeof record.circleId === "string") values.circleId = record.circleId;
  if (typeof record.personId === "number" && record.personId > 0) values.personId = String(record.personId);
  if (Array.isArray(record.workCodes))
    values.workCodes = record.workCodes.filter((code) => typeof code === "string").join("\n");
  if (typeof record.sourceId === "number" && record.sourceId > 0) values.sourceId = record.sourceId;
  if (typeof record.purchaseBonusAutoLink === "boolean") values.purchaseBonusAutoLink = record.purchaseBonusAutoLink;
  if (record.remoteMetadataFallback && typeof record.remoteMetadataFallback === "object") {
    const fallback = record.remoteMetadataFallback as Record<string, unknown>;
    values.remoteMetadataFallback = {
      enabled: fallback.enabled === true,
      sourceIds: Array.isArray(fallback.sourceIds)
        ? [...new Set(fallback.sourceIds.filter((id): id is number => typeof id === "number" && id > 0))]
        : [],
    };
  }
  if (values.scope === "circle") values.sourceId = 0;
  return values;
}

export function metadataSyncPayload(values: MetadataSyncFormValues): MetadataSyncOptions {
  const payload: MetadataSyncOptions = { scope: values.scope, mode: values.mode };
  if (values.scope === "circle") payload.circleId = values.circleId.trim().toUpperCase();
  if (values.scope === "voice") payload.personId = Number(values.personId);
  if (values.scope === "works") payload.workCodes = metadataSyncWorkCodes(values.workCodes);
  const sourceId = metadataSyncSourceId(values);
  if (sourceId > 0) payload.sourceId = sourceId;
  else {
    payload.remoteMetadataFallback = values.remoteMetadataFallback.enabled
      ? { ...values.remoteMetadataFallback, sourceIds: [...values.remoteMetadataFallback.sourceIds] }
      : { enabled: false, sourceIds: [] };
    payload.purchaseBonusAutoLink = values.purchaseBonusAutoLink;
  }
  return payload;
}

export function metadataSyncBlockers(values: MetadataSyncFormValues, sources?: LibrarySource[]): MetadataSyncBlocker[] {
  if (values.scope === "circle" && !circleIdPattern.test(values.circleId.trim())) return ["circle_required"];
  if (values.scope === "voice" && (values.sourceId === 0 || (sources && metadataSyncSources(sources).length === 0)))
    return ["voice_source_required"];
  if (values.scope === "voice" && !(Number(values.personId) > 0)) return ["voice_required"];
  if (values.scope === "works") {
    const codes = metadataSyncWorkCodes(values.workCodes);
    if (codes.length === 0 || codes.length > 100 || codes.some((code) => !/^(RJ|BJ|VJ|CC)\d{5,8}$/.test(code)))
      return ["works_required"];
  }
  const capable = sources && new Set(metadataSyncSources(sources).map((source) => source.id));
  const sourceId = metadataSyncSourceId(values);
  if (sourceId > 0 && capable && !capable.has(sourceId)) return ["source_required"];
  if (
    sourceId === 0 &&
    values.remoteMetadataFallback.enabled &&
    (values.remoteMetadataFallback.sourceIds.length === 0 ||
      values.remoteMetadataFallback.sourceIds.length > 16 ||
      values.remoteMetadataFallback.sourceIds.some((id) => capable && !capable.has(id)))
  )
    return ["fallback_required"];
  return [];
}

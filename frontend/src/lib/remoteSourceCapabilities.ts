import type { FileSource } from "@/lib/api";

/** Capability a remote source declares when its API can describe works. */
export const METADATA_CAPABILITY = "metadata";

const METADATA_SOURCE_TYPES = new Set(["kikoeru_compatible", "kikoeru_compatible_number178"]);

/**
 * Whether a source declares the metadata capability. A remote source without
 * a declared list keeps its type's default; an explicit list is authoritative.
 */
export function sourceProvidesMetadata(source: Pick<FileSource, "sourceType" | "config">): boolean {
  if (!METADATA_SOURCE_TYPES.has(source.sourceType)) return false;
  const capabilities = source.config.capabilities;
  return capabilities === undefined || capabilities.includes(METADATA_CAPABILITY);
}

/** Returns config with the metadata capability declared on or off. */
export function withMetadataCapability(config: FileSource["config"], enabled: boolean): FileSource["config"] {
  return { ...config, capabilities: enabled ? [METADATA_CAPABILITY] : [] };
}

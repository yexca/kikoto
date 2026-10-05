import type { FileSource, RemoteMetadataFallbackSettings } from "@/lib/api";
import { sourceProvidesMetadata } from "@/lib/remoteSourceCapabilities";

export const defaultRemoteMetadataFallback: RemoteMetadataFallbackSettings = { enabled: false, sourceIds: [] };

export type RemoteMetadataFallbackRow = {
  source: FileSource;
  selected: boolean;
  /** Position in the fallback order, or -1 when not selected. */
  position: number;
};

/**
 * Lists metadata-capable sources: selected ones first in their fallback order,
 * then the others by source priority and id. Selected ids that no longer name
 * a capable source are dropped.
 */
export function remoteMetadataFallbackRows(
  sources: FileSource[],
  settings: RemoteMetadataFallbackSettings,
): RemoteMetadataFallbackRow[] {
  const capable = sources.filter(sourceProvidesMetadata);
  const selected = normalizedSourceIds(capable, settings.sourceIds);
  const rows = capable.map((source) => {
    const position = selected.indexOf(source.id);
    return { source, selected: position >= 0, position };
  });
  return rows.sort((left, right) => {
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    if (left.selected) return left.position - right.position;
    return left.source.priority - right.source.priority || left.source.id - right.source.id;
  });
}

/** Removes ids of sources that are missing or no longer provide metadata. */
export function normalizedRemoteMetadataFallback(
  sources: FileSource[],
  settings: RemoteMetadataFallbackSettings,
): RemoteMetadataFallbackSettings {
  return {
    enabled: settings.enabled,
    sourceIds: normalizedSourceIds(sources.filter(sourceProvidesMetadata), settings.sourceIds),
  };
}

export function sameRemoteMetadataFallback(
  left: RemoteMetadataFallbackSettings,
  right: RemoteMetadataFallbackSettings,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every((id, index) => id === right.sourceIds[index])
  );
}

/** Selecting appends the source to the end of the order; clearing removes it. */
export function toggleRemoteMetadataSource(
  settings: RemoteMetadataFallbackSettings,
  id: number,
  selected: boolean,
): RemoteMetadataFallbackSettings {
  const remaining = settings.sourceIds.filter((value) => value !== id);
  return { ...settings, sourceIds: selected ? [...remaining, id] : remaining };
}

/** Moves a selected source one step earlier (-1) or later (+1). */
export function moveRemoteMetadataSource(
  settings: RemoteMetadataFallbackSettings,
  id: number,
  delta: -1 | 1,
): RemoteMetadataFallbackSettings {
  const index = settings.sourceIds.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= settings.sourceIds.length) return settings;
  const sourceIds = [...settings.sourceIds];
  [sourceIds[index], sourceIds[target]] = [sourceIds[target], sourceIds[index]];
  return { ...settings, sourceIds };
}

function normalizedSourceIds(capable: FileSource[], ids: number[]) {
  const known = new Set(capable.map((source) => source.id));
  return ids.filter((id, index) => known.has(id) && ids.indexOf(id) === index);
}

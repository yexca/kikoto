import type { CacheOverview } from "@/lib/api";

export type CacheCleanupMode = "orphans" | "works";

export type CacheCleanupRow = {
  key: string;
  workId: number;
  workCode: string;
  groupKey: string;
  groupLabel: string;
  sourceLabel: string;
  files: number;
  bytes: number;
};

export type CacheCleanupGroup = {
  key: string;
  label: string;
  rows: CacheCleanupRow[];
  files: number;
  bytes: number;
};

export type CacheCleanupLabels = {
  unknownSource: string;
  multipleSources: string;
  sourcesCount: (count: number) => string;
};

export function cacheCleanupRows(
  overview: CacheOverview | null,
  mode: CacheCleanupMode,
  labels: CacheCleanupLabels,
): CacheCleanupRow[] {
  if (!overview) return [];
  if (mode === "orphans") {
    return overview.works
      .filter((row) => row.orphanFiles > 0 || row.emptyDirectories > 0)
      .map((row) => {
        const sourceLabel = row.sourceName.trim() || row.sourceCode.trim() || labels.unknownSource;
        return {
          key: row.groupKey,
          workId: row.workId,
          workCode: row.workCode,
          groupKey: `source:${row.sourceCode || row.sourceId || "unknown"}`,
          groupLabel: sourceLabel,
          sourceLabel,
          files: row.orphanFiles,
          bytes: row.orphanBytes,
        };
      });
  }

  const works = new Map<
    number,
    Omit<CacheCleanupRow, "groupKey" | "groupLabel" | "sourceLabel"> & { sources: Map<string, string> }
  >();
  for (const row of overview.works) {
    if (row.workId <= 0 || row.referencedFiles <= 0) continue;
    const current = works.get(row.workId) ?? {
      key: String(row.workId),
      workId: row.workId,
      workCode: row.workCode,
      files: 0,
      bytes: 0,
      sources: new Map<string, string>(),
    };
    current.files += row.referencedFiles;
    current.bytes += row.referencedBytes;
    const sourceKey = row.sourceCode.trim() || String(row.sourceId || "unknown");
    current.sources.set(sourceKey, row.sourceName.trim() || row.sourceCode.trim() || labels.unknownSource);
    works.set(row.workId, current);
  }
  return Array.from(works.values())
    .sort((left, right) => left.workCode.localeCompare(right.workCode))
    .map(({ sources, ...row }) => {
      const sourceEntries = Array.from(sources.entries());
      const singleSource = sourceEntries.length === 1 ? sourceEntries[0] : null;
      return {
        ...row,
        groupKey: singleSource ? `source:${singleSource[0]}` : "source:multiple",
        groupLabel: singleSource?.[1] ?? labels.multipleSources,
        sourceLabel: singleSource?.[1] ?? labels.sourcesCount(sourceEntries.length),
      };
    });
}

export function cacheCleanupGroups(rows: CacheCleanupRow[]): CacheCleanupGroup[] {
  const groups = new Map<string, CacheCleanupGroup>();
  for (const row of rows) {
    const group = groups.get(row.groupKey) ?? {
      key: row.groupKey,
      label: row.groupLabel,
      rows: [],
      files: 0,
      bytes: 0,
    };
    group.rows.push(row);
    group.files += row.files;
    group.bytes += row.bytes;
    groups.set(row.groupKey, group);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      rows: [...group.rows].sort((left, right) => left.workCode.localeCompare(right.workCode)),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function formatByteSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** Share of a limit in whole percent, clamped for progress bars. */
export function usagePercent(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

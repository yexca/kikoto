import type { CircleCatalogWork, CircleDetail, CircleSeries, CircleSourceStat, ListeningStatus } from "@/lib/api";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import type { WorkDetailIntent } from "@/app/workDetailNavigation";
import type { RemoteWorkTarget } from "@/pages/remoteBulkRunModel";

const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

export function circleWorkKey(work: CircleCatalogWork) {
  return work.primaryCode;
}

export function seriesCodeForWork(series: CircleSeries[], workCode: string) {
  const normalizedCode = workCode.toUpperCase();
  return series.find((item) => item.workCodes.some((code) => code.toUpperCase() === normalizedCode))?.titleId ?? null;
}

export function emptyCircleDetail(externalId: string): CircleDetail {
  return {
    id: 0,
    externalId,
    displayName: externalId,
    aliases: [],
    rating: null,
    note: "",
    favorite: false,
    userTags: [],
    localWorks: 0,
    playableWorks: 0,
    remoteWorks: 0,
    missingWorks: 0,
    catalogWorks: 0,
    lastSyncedAt: null,
    syncState: "never",
    syncReason: "never",
    sourceSummaries: [],
    latestWork: null,
    availableWorks: 0,
    works: [],
    worksMeta: { page: 1, pageSize: 24, loaded: 0, total: 0, hasMore: false, truncated: false },
    series: [],
  };
}

export function normalizeListeningStatus(status: string): ListeningStatus {
  return listeningStatusOptions.some((option) => option.value === status) ? (status as ListeningStatus) : "none";
}

function availableSourceTags(sources: CircleSourceStat[] | null | undefined) {
  const seen = new Set<string>();
  return (sources ?? []).filter((source) => {
    if (source.status !== "available" && source.count <= 0) return false;
    if (source.key === "cache") return false;
    const key = source.key;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function preferredDirectoryTarget(work: CircleCatalogWork) {
  const tags = availableSourceTags(work.sourceTags);
  const local = tags.find((tag) => tag.key === "local");
  if (local && work.workId !== null) {
    return { kind: "known", canonicalCode: work.primaryCode } satisfies WorkDetailIntent;
  }
  const remote = tags.find((tag) => tag.sourceId !== undefined && tag.sourceId !== null);
  if (remote?.sourceId) {
    const remoteCode = work.remoteCode || work.primaryCode;
    return work.workId !== null
      ? ({
          kind: "known",
          canonicalCode: work.primaryCode,
          source: { sourceId: remote.sourceId, remoteCode },
        } satisfies WorkDetailIntent)
      : ({ kind: "remote-only", sourceId: remote.sourceId, remoteCode } satisfies WorkDetailIntent);
  }
  if (work.workId !== null) {
    return { kind: "known", canonicalCode: work.primaryCode } satisfies WorkDetailIntent;
  }
  return null;
}

export function isCircleBulkSaveSelectable(work: CircleCatalogWork) {
  if (work.local) return false;
  return circleWorkRemoteTarget(work) !== null;
}

export function circleRemoteTargets(works: readonly CircleCatalogWork[]): RemoteWorkTarget[] {
  return works.flatMap((work) => circleWorkRemoteTarget(work) ?? []);
}

export function circleWorkRemoteTarget(
  work: CircleCatalogWork,
): { sourceId: number; code: string; sourceDisplayName: string } | null {
  const remote = availableSourceTags(work.sourceTags).find(
    (tag) => tag.sourceId !== undefined && tag.sourceId !== null,
  );
  return remote?.sourceId
    ? { sourceId: remote.sourceId, code: work.remoteCode || work.primaryCode, sourceDisplayName: remote.displayName }
    : null;
}

export function dlsiteMakerURL(externalId: string) {
  const site = externalId.toUpperCase().startsWith("VG") ? "pro" : "maniax";
  return DLSITE_ENDPOINTS.makerURL(site, externalId);
}

export function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("VJ") ? "pro" : "maniax";
  return DLSITE_ENDPOINTS.workURL(site, code);
}

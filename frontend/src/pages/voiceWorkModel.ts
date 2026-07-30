import type { CircleSourceStat, VoiceKnownWork, VoiceRemoteObservation, VoiceRemoteSourceSet, VoiceRemoteWork } from "@/lib/api";

export type VoiceWorkView = (VoiceKnownWork | VoiceRemoteWork) & {
  remoteObservations?: VoiceRemoteObservation[];
};

export function mergeVoiceWorks(knownWorks: VoiceKnownWork[], sourceSets: VoiceRemoteSourceSet[]): VoiceWorkView[] {
  const remoteWorks = sourceSets
    .filter((source) => source.status === "ok")
    .flatMap((source) => source.works);
  const remoteByCanonicalCode = groupRemoteWorks(remoteWorks);
  const consumedCodes = new Set<string>();

  const mergedKnown = knownWorks.map((work): VoiceWorkView => {
    const key = normalizedCode(work.primaryCode);
    const matches = remoteByCanonicalCode.get(key) ?? [];
    const persistedObservations = work.remoteObservations ?? [];
    const preferredCodes = [
      work.remoteCode,
      ...persistedObservations.filter((observation) => normalizedAvailability(observation.status) === "available").map((observation) => observation.remoteCode),
      work.primaryCode,
    ];
    const observations = mergeRemoteObservations(
      persistedObservations,
      liveRemoteObservations(matches),
      preferredCodes,
    );
    if (matches.length === 0 && observations.length === 0) return work;
    if (matches.length > 0) consumedCodes.add(key);
    return {
      ...work,
      remoteObservations: observations,
      sourceTags: mergeObservedSourceTags(work.sourceTags, observations),
    };
  });

  const mergedRemote: VoiceWorkView[] = [];
  for (const remoteWork of remoteWorks) {
    const key = normalizedCode(remoteWork.primaryCode);
    if (consumedCodes.has(key)) continue;
    consumedCodes.add(key);
    const matches = remoteByCanonicalCode.get(key) ?? [remoteWork];
    mergedRemote.push({
      ...remoteWork,
      remoteObservations: liveRemoteObservations(matches, [remoteWork.remoteCode, remoteWork.primaryCode]),
    });
  }
  return [...mergedKnown, ...mergedRemote];
}

export function voiceWorkRemoteTarget(work: VoiceWorkView): { sourceId: number; code: string } | null {
  const observation = work.remoteObservations?.find((item) => item.status === "available");
  if (observation) return { sourceId: observation.sourceId, code: observation.remoteCode };
  if ("sourceId" in work && validSourceID(work.sourceId)) {
    const code = (work.remoteCode || work.primaryCode).trim();
    return code ? { sourceId: work.sourceId, code } : null;
  }
  if (!("sourceTags" in work)) return null;
  const source = work.sourceTags.find((tag) => validSourceID(tag.sourceId) && tag.key !== "cache" && tag.status === "available");
  const code = (work.remoteCode || work.primaryCode).trim();
  return source?.sourceId && code ? { sourceId: source.sourceId, code } : null;
}

export function voiceWorkObservedSourceTags(work: VoiceWorkView) {
  if ("sourceTags" in work) return work.sourceTags;
  return mergeObservedSourceTags([], work.remoteObservations ?? []);
}

export function voiceWorkHasRemoteAvailability(work: VoiceWorkView) {
  if (work.remoteObservations?.some((observation) => observation.status === "available")) return true;
  if ("sourceTags" in work) {
    return work.remote || work.sourceTags.some((tag) => tag.key !== "cache" && validSourceID(tag.sourceId) && tag.status === "available");
  }
  return work.hasRemote || work.remotePlayable;
}

function groupRemoteWorks(remoteWorks: VoiceRemoteWork[]) {
  const grouped = new Map<string, VoiceRemoteWork[]>();
  for (const work of remoteWorks) {
    const key = normalizedCode(work.primaryCode);
    if (!key) continue;
    const values = grouped.get(key) ?? [];
    values.push(work);
    grouped.set(key, values);
  }
  return grouped;
}

function liveRemoteObservations(works: VoiceRemoteWork[], preferredCodes: string[] = []) {
  const seen = new Set<string>();
  const observations: VoiceRemoteObservation[] = [];
  for (const work of works) {
    const remoteCode = (work.remoteCode || work.primaryCode).trim();
    if (!validSourceID(work.sourceId) || !remoteCode) continue;
    const key = `${work.sourceId}:${normalizedCode(remoteCode)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    observations.push({
      sourceId: work.sourceId,
      sourceCode: work.sourceCode,
      sourceName: work.sourceName,
      remoteCode,
      status: "available",
    });
  }
  const preferred = preferredCodes.map(normalizedCode).filter(Boolean);
  return observations
    .map((observation, index) => ({ observation, index }))
    .sort((left, right) => preferredCodeRank(left.observation.remoteCode, preferred) - preferredCodeRank(right.observation.remoteCode, preferred) || left.index - right.index)
    .map(({ observation }) => observation);
}

function mergeRemoteObservations(left: VoiceRemoteObservation[], right: VoiceRemoteObservation[], preferredCodes: string[]) {
  const byKey = new Map<string, VoiceRemoteObservation>();
  for (const observation of [...left, ...right]) {
    const remoteCode = observation.remoteCode.trim();
    if (!validSourceID(observation.sourceId) || !remoteCode) continue;
    const normalized: VoiceRemoteObservation = {
      ...observation,
      remoteCode,
      status: normalizedAvailability(observation.status),
    };
    const key = `${observation.sourceId}:${normalizedCode(remoteCode)}`;
    const existing = byKey.get(key);
    if (!existing || availabilityPriority(normalized.status) >= availabilityPriority(existing.status)) {
      byKey.set(key, normalized);
    }
  }
  const preferred = preferredCodes.map(normalizedCode).filter(Boolean);
  return Array.from(byKey.values())
    .map((observation, index) => ({ observation, index }))
    .sort((leftItem, rightItem) => preferredCodeRank(leftItem.observation.remoteCode, preferred) - preferredCodeRank(rightItem.observation.remoteCode, preferred) || leftItem.index - rightItem.index)
    .map(({ observation }) => observation);
}

function preferredCodeRank(code: string, preferredCodes: string[]) {
  const index = preferredCodes.indexOf(normalizedCode(code));
  return index === -1 ? preferredCodes.length : index;
}

function mergeObservedSourceTags(sourceTags: CircleSourceStat[], observations: VoiceRemoteObservation[]) {
  const byKey = new Map<string, CircleSourceStat>();
  for (const tag of sourceTags) byKey.set(sourceTagKey(tag), tag);
  for (const observation of observations) {
    const status = normalizedAvailability(observation.status);
    const tag: CircleSourceStat = {
      key: `source:${observation.sourceId}`,
      sourceId: observation.sourceId,
      displayName: observation.sourceName || observation.sourceCode || "Remote source",
      status,
      count: status === "available" ? 1 : 0,
    };
    const key = sourceTagKey(tag);
    const existing = byKey.get(key);
    if (!existing || availabilityPriority(tag.status) > availabilityPriority(existing.status)) byKey.set(key, tag);
  }
  return Array.from(byKey.values());
}

function sourceTagKey(tag: CircleSourceStat) {
  return tag.sourceId ? `source:${tag.sourceId}` : tag.key;
}

function normalizedCode(value: string) {
  return value.trim().toUpperCase();
}

function validSourceID(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizedAvailability(value: string): VoiceRemoteObservation["status"] {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "available":
    case "disabled":
    case "error":
    case "unavailable":
    case "not_found":
    case "unknown":
      return normalized;
    case "missing":
      return "not_found";
    default:
      return "unknown";
  }
}

function availabilityPriority(status: string) {
  switch (status) {
    case "available": return 6;
    case "disabled": return 5;
    case "error": return 4;
    case "unavailable": return 3;
    case "not_found": return 2;
    case "unknown": return 1;
    default: return 0;
  }
}

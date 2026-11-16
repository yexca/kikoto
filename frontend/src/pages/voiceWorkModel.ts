import type { CircleSourceStat, VoiceRemoteObservation, VoiceWork } from "@/lib/api";

/** The availability filter of a voice actor's works. */
export type VoiceWorkFilter = "all" | "available" | "local" | "remote" | "missing";

/** A work on a voice actor page, as its works endpoint pages it. */
export type VoiceWorkView = VoiceWork;

export function voiceWorkRemoteTarget(work: VoiceWorkView): { sourceId: number; code: string } | null {
  const observation = work.remoteObservations?.find((item) => item.status === "available");
  if (observation) return { sourceId: observation.sourceId, code: observation.remoteCode };
  if ("sourceId" in work && validSourceID(work.sourceId)) {
    if (!work.remotePlayable && work.availability !== "available" && !work.hasRemote) return null;
    const code = (work.remoteCode || work.primaryCode).trim();
    return code ? { sourceId: work.sourceId, code } : null;
  }
  if (!("sourceTags" in work)) return null;
  const source = work.sourceTags.find(
    (tag) => validSourceID(tag.sourceId) && tag.key !== "cache" && tag.status === "available",
  );
  const code = (work.remoteCode || work.primaryCode).trim();
  return source?.sourceId && code ? { sourceId: source.sourceId, code } : null;
}

export function voiceWorkObservedSourceTags(work: VoiceWorkView) {
  if ("sourceTags" in work) return work.sourceTags;
  return observedSourceTags(work.remoteObservations ?? []);
}

export function voiceWorkHasRemoteAvailability(work: VoiceWorkView) {
  if (work.remoteObservations?.some((observation) => observation.status === "available")) return true;
  if ("sourceTags" in work) {
    return (
      work.remote ||
      work.sourceTags.some((tag) => tag.key !== "cache" && validSourceID(tag.sourceId) && tag.status === "available")
    );
  }
  return work.hasRemote || work.remotePlayable;
}

/** One tag per observed source, keeping the strongest status the source reported. */
function observedSourceTags(observations: VoiceRemoteObservation[]) {
  const bySource = new Map<number, CircleSourceStat>();
  for (const observation of observations) {
    const status = normalizedAvailability(observation.status);
    const existing = bySource.get(observation.sourceId);
    if (existing && availabilityPriority(status) <= availabilityPriority(existing.status)) continue;
    bySource.set(observation.sourceId, {
      key: `source:${observation.sourceId}`,
      sourceId: observation.sourceId,
      displayName: observation.sourceName || observation.sourceCode || "Remote source",
      status,
      count: status === "available" ? 1 : 0,
    });
  }
  return Array.from(bySource.values());
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
    case "available":
      return 6;
    case "disabled":
      return 5;
    case "error":
      return 4;
    case "unavailable":
      return 3;
    case "not_found":
      return 2;
    case "unknown":
      return 1;
    default:
      return 0;
  }
}

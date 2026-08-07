import { voiceWorkHasRemoteAvailability, voiceWorkObservedSourceTags, type VoiceWorkView } from "./voiceWorkModel";

const explicitNegativeStatuses = new Set(["missing", "not_found", "unavailable"]);

export function voiceWorkIsExplicitlyUnavailable(work: VoiceWorkView) {
  const local = "local" in work ? work.local : work.hasLocal;
  const cache = "cache" in work ? work.cache : work.hasCache;
  if (local || cache || voiceWorkHasRemoteAvailability(work)) return false;

  return voiceWorkObservedSourceTags(work).some(
    (source) =>
      source.key !== "cache" &&
      typeof source.sourceId === "number" &&
      source.sourceId > 0 &&
      explicitNegativeStatuses.has(source.status.trim().toLowerCase()),
  );
}

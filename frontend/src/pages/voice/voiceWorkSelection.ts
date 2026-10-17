import { voiceWorkRemoteTarget, type VoiceWorkView } from "@/pages/voiceWorkModel";

export function voiceRemoteTargets(works: readonly VoiceWorkView[]) {
  return works.flatMap((work) => voiceWorkRemoteTarget(work) ?? []);
}

export function voiceWorkSelectionKey(work: VoiceWorkView) {
  return `${"sourceId" in work ? work.sourceId : "known"}:${work.primaryCode}`;
}

export function isVoiceBulkSelectable(work: VoiceWorkView) {
  if ("local" in work && work.local) return false;
  return voiceWorkRemoteTarget(work) !== null;
}

/** A selected work Fetch saves: one a remote source holds. */
export function isVoiceWorkFetchable(work: VoiceWorkView) {
  return voiceWorkRemoteTarget(work) !== null;
}

/** A selected work Fork tracks: one on a remote source that is not in the Library yet. */
export function isVoiceWorkForkable(work: VoiceWorkView) {
  return isVoiceWorkFetchable(work) && !voiceWorkHasImportedRemote(work);
}

function voiceWorkHasImportedRemote(work: VoiceWorkView) {
  if ("remote" in work) return work.remote;
  return work.hasRemote;
}

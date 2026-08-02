import type { RemoteWorkTrackResult } from "@/lib/api";

export const REMOTE_TRACK_CREATED_EVENT = "kikoto:remote-track-created";
export const REMOTE_TRACK_TERMINAL_EVENT = "kikoto:remote-track-terminal";

export type RemoteTrackCreatedDetail = {
  runId: number;
  sourceId: number;
  requestedCode: string;
  primaryCode: string;
  status: string;
  deduplicated: boolean;
};

export type RemoteTrackTerminalDetail = RemoteTrackCreatedDetail & {
  status: string;
  workId: number | null;
  fileSourceId: number;
};

export function announceRemoteTrackCreated(sourceId: number, requestedCode: string, result: RemoteWorkTrackResult) {
  const detail: RemoteTrackCreatedDetail = {
    runId: result.runId,
    sourceId,
    requestedCode: requestedCode.trim().toUpperCase(),
    primaryCode: result.primaryCode.trim().toUpperCase(),
    status: result.status,
    deduplicated: result.deduplicated,
  };
  window.dispatchEvent(new CustomEvent<RemoteTrackCreatedDetail>(REMOTE_TRACK_CREATED_EVENT, { detail }));
  return detail;
}

export function isMatchingRemoteTrack(
  detail: RemoteTrackTerminalDetail,
  sourceId: number,
  ...codes: Array<string | null | undefined>
) {
  if (detail.sourceId !== sourceId) return false;
  const expected = new Set(codes.map((code) => code?.trim().toUpperCase()).filter(Boolean));
  return expected.size === 0 || expected.has(detail.requestedCode) || expected.has(detail.primaryCode);
}

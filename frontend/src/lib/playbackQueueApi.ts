import { getJSON, postJSONBody } from "@/lib/apiTransport";
import type { LyricsAIModels, LyricsChoiceReason, MediaProgress } from "@/lib/mediaApi";

/** A location a media item plays from, with the URL the player streams it through. */
export type MediaPlaybackLocation = {
  locationId: number;
  locationType: string;
  streamUrl: string;
  sourceId: number;
  sourceName: string;
  availability: string;
};

/** A lyrics file a queued track can show, as the player reads it. */
export type PlaybackLyricsChoice = {
  mediaItemId: number;
  locationId: number;
  title: string;
  path: string;
  /** The file's path in the work's Directory tree. */
  displayPath?: string;
  reason: LyricsChoiceReason;
  language?: string;
  ai?: LyricsAIModels;
};

/** Everything the player needs to queue a work file, as the server resolves it. */
export type PlaybackQueueTrack = {
  mediaItemId: number;
  workId: number;
  locationId: number;
  title: string;
  displayTitle?: string;
  kind: "audio" | "video";
  folderPath: string;
  locationType: string;
  streamUrl: string;
  availability: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  progress: MediaProgress | null;
  /** The locations the track can play from, in playback priority. */
  locations: MediaPlaybackLocation[];
  /** The automatic choice first; `preferredLyricsMediaItemId` is the viewer's own. */
  lyricsChoices: PlaybackLyricsChoice[];
  preferredLyricsMediaItemId: number | null;
  lyricsOffsetMs: number;
  lyricsPreferencePersistable: boolean;
};

/** The work information the player shows with a track. */
export type PlaybackQueueWork = {
  id: number;
  primaryCode: string;
  title: string;
  coverUrl: string;
  circle: string;
  voiceActors: string[];
};

export type PlaybackQueueResolveItem = {
  mediaItemId: number;
  workId: number;
  /** The location the track was on. */
  locationId: number;
  /** The listener picked that location in the player. */
  locationChosen?: boolean;
};

/**
 * A queued item as the library has it now: playable, unavailable when no
 * location can play now (such as a file on an offline storage pool), or
 * missing when the item or its work is gone.
 */
export type PlaybackQueueResolvedItem = {
  mediaItemId: number;
  workId: number;
  status: "playable" | "unavailable" | "missing";
  track?: PlaybackQueueTrack;
};

export type PlaybackQueueResolution = {
  items: PlaybackQueueResolvedItem[];
  works: PlaybackQueueWork[];
};

/** The queue Resume plays: the cursor edition's playable files, starting at the cursor's track and position. */
export type WorkResumeQueue = {
  mediaWorkId: number;
  startIndex: number;
  positionSeconds: number;
  tracks: PlaybackQueueTrack[];
  work: PlaybackQueueWork;
};

export const playbackQueueApi = {
  /** Resolves queued items against the library; `titlesOnly` refreshes only their names. */
  resolvePlaybackQueue: (items: PlaybackQueueResolveItem[], options: { titlesOnly?: boolean } = {}) =>
    postJSONBody<PlaybackQueueResolution>("/api/playback/queue/resolve", {
      items,
      titlesOnly: options.titlesOnly ?? false,
    }),
  /** The queue Resume plays for a work's saved cursor; null when the cursor cannot resume. */
  getWorkResumeQueue: (workId: number, signal?: AbortSignal) =>
    getJSON<{ resume: WorkResumeQueue | null }>(`/api/works/${workId}/resume-queue`, signal),
};

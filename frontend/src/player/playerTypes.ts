import type { MediaProgress } from "@/lib/api";
import type { LyricsChoice } from "./lyricsMatching";

export type PlayMode = "order" | "loop" | "single";

export type DockMode = "full" | "compact" | "mini";

export type PlayerTrack = {
  queueItemId?: string;
  mediaItemId: number;
  locationId: number;
  /** The file's real name, which also decides lyrics matching. */
  title: string;
  /** The name the directory showed for the file when it was queued, when that differs from the real one. */
  displayTitle?: string;
  kind: "audio" | "video";
  folderPath: string;
  locationType: string;
  streamUrl: string;
  sizeBytes: number | null;
  durationSeconds?: number | null;
  availability: string;
  workId: number;
  workCode: string;
  workTitle: string;
  coverUrl: string;
  circle: string;
  progress: MediaProgress | null;
  progressRecordable: boolean;
  lyricsLocationId: number | null;
  lyricsTitle: string;
  lyricsChoices?: LyricsChoice[];
  autoLyricsLocationId?: number | null;
  preferredLyricsMediaItemId?: number | null;
  /** The listener's lyrics timing offset in milliseconds; positive shows each line later. */
  lyricsOffsetMs?: number;
  remoteSourceId?: number;
  remoteWorkCode?: string;
  remotePath?: string;
  playbackKey?: string;
  locations?: PlayerTrackLocation[];
  /** The app page the track was queued from; the player leads back to it. */
  originPage?: string;
  /** The work detail location the track was queued from, when it was queued from one. */
  originWorkLocation?: string;
};

export type LyricsPreferenceTarget = {
  mediaItemId: number;
  /** The media kind of the track the lyrics accompany. */
  kind?: string;
  playbackKey?: string;
  lyricsChoices?: LyricsChoice[];
  autoLyricsLocationId?: number | null;
  preferredLyricsMediaItemId?: number | null;
  lyricsPreferencePersistable?: boolean;
  progressRecordable?: boolean;
};

export type PlayerTrackLocation = {
  locationId: number;
  locationType: string;
  streamUrl: string;
  sourceId: number;
  sourceName: string;
  availability: string;
};

export type PlaybackCompatibilityScope = "off" | "track" | "queue" | "always";

export type SleepTimerState = {
  mode: "deadline";
  deadline: number;
  finishCurrentTrack: boolean;
  waitingForTrackEnd: boolean;
} | null;

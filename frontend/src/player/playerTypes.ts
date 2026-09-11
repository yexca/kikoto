import type { MediaProgress } from "@/lib/api";
import type { LyricsChoice } from "./lyricsMatching";

export type PlayMode = "order" | "loop" | "single";

export type DockMode = "full" | "compact" | "mini";

export type PlayerTrack = {
  queueItemId?: string;
  mediaItemId: number;
  locationId: number;
  title: string;
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
  remoteSourceId?: number;
  remoteWorkCode?: string;
  remotePath?: string;
  playbackKey?: string;
  locations?: PlayerTrackLocation[];
};

export type LyricsPreferenceTarget = {
  mediaItemId: number;
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

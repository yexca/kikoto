import type { TFunction } from "i18next";

import type { VideoAudioTrack, VideoPlaybackInfo } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

/** A viewer offers a choice of audio only when the video has two tracks or more. */
export function videoAudioTrackChoices(playback: Pick<VideoPlaybackInfo, "audioTracks"> | null | undefined) {
  const tracks = playback?.audioTracks ?? [];
  return tracks.length >= 2 ? tracks : [];
}

function languageName(code: string, locale: string) {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

function channelLabel(channels: number | undefined, t: TFunction) {
  switch (channels) {
    case undefined:
    case 0:
      return "";
    case 1:
      return t("videoPlayback.audioMono");
    case 2:
      return t("videoPlayback.audioStereo");
    case 6:
      return "5.1";
    case 8:
      return "7.1";
    default:
      return t("videoPlayback.audioChannels", { count: channels });
  }
}

/** Names a track by its position, then its title, language, and channel layout where the file says. */
export function videoAudioTrackLabel(track: VideoAudioTrack, position: number, t: TFunction, locale: string) {
  const language = track.language ? languageName(track.language, locale) : "";
  const parts = [t("videoPlayback.audioTrackNumber", { number: position + 1 })];
  if (track.title) parts.push(track.title);
  if (language && language !== track.title) parts.push(language);
  const channels = channelLabel(track.channels, t);
  if (channels) parts.push(channels);
  return parts.join(" · ");
}

// The track chosen for a file lasts for this page session, per signed-in user.
const chosenAudioStreams = new Map<string, number>();

function chosenAudioStreamKey(userId: ClientPrincipalID, locationId: number) {
  return `${userId ?? ""}:${locationId}`;
}

export function chosenVideoAudioStream(userId: ClientPrincipalID, locationId: number) {
  return chosenAudioStreams.get(chosenAudioStreamKey(userId, locationId)) ?? null;
}

export function chooseVideoAudioStream(userId: ClientPrincipalID, locationId: number, streamIndex: number) {
  chosenAudioStreams.set(chosenAudioStreamKey(userId, locationId), streamIndex);
}

/** Drops a choice the server no longer accepts, such as a track of a file that changed. */
export function forgetChosenVideoAudioStream(userId: ClientPrincipalID, locationId: number) {
  chosenAudioStreams.delete(chosenAudioStreamKey(userId, locationId));
}

export function rejectsVideoAudioStream(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "invalid_audio_stream";
}

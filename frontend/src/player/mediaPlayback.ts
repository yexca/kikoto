export type PlaybackProfile = "audio" | "video";

type CapabilitySpec = {
  key: string;
  mime: string;
};

const audioCapabilities: CapabilitySpec[] = [
  { key: "audio-mp3", mime: "audio/mpeg" },
  { key: "audio-mp4-aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { key: "audio-webm-opus", mime: 'audio/webm; codecs="opus"' },
  { key: "audio-webm-vorbis", mime: 'audio/webm; codecs="vorbis"' },
  { key: "audio-wav", mime: "audio/wav" },
];

const videoCapabilities: CapabilitySpec[] = [
  { key: "video-mp4-h264-aac", mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' },
  { key: "video-mp4-h264-mp3", mime: 'video/mp4; codecs="avc1.42E01E, mp3"' },
  { key: "video-mp4-h264-noaudio", mime: 'video/mp4; codecs="avc1.42E01E"' },
  { key: "video-webm-vp8-opus", mime: 'video/webm; codecs="vp8, opus"' },
  { key: "video-webm-vp8-vorbis", mime: 'video/webm; codecs="vp8, vorbis"' },
  { key: "video-webm-vp8-noaudio", mime: 'video/webm; codecs="vp8"' },
  { key: "video-webm-vp9-opus", mime: 'video/webm; codecs="vp9, opus"' },
  { key: "video-webm-vp9-vorbis", mime: 'video/webm; codecs="vp9, vorbis"' },
  { key: "video-webm-vp9-noaudio", mime: 'video/webm; codecs="vp9"' },
];

function capabilitySpecs(profile: PlaybackProfile) {
  return profile === "audio" ? audioCapabilities : videoCapabilities;
}

export function playbackCapabilities(profile: PlaybackProfile): string[] {
  if (typeof document === "undefined") return [];
  const element = document.createElement(profile);
  if (typeof element.canPlayType !== "function") return [];
  return capabilitySpecs(profile)
    .filter(({ mime }) => {
      try {
        return element.canPlayType(mime) !== "";
      } catch {
        return false;
      }
    })
    .map(({ key }) => key);
}

function appendQuery(url: string, query: URLSearchParams) {
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return `${base}${separator}${query.toString()}${hash}`;
}

export function playbackURL(url: string, profile: PlaybackProfile, forceTranscode = false) {
  if (!url) return "";
  const query = new URLSearchParams();
  query.set("profile", profile);
  const capabilities = playbackCapabilities(profile);
  if (capabilities.length > 0) query.set("capabilities", capabilities.join(","));
  if (forceTranscode) query.set("forceTranscode", "1");
  return appendQuery(url, query);
}

export function remoteMediaPlaybackURL(
  sourceId: number,
  workCode: string,
  remotePath: string,
  profile: PlaybackProfile,
  forceTranscode = false,
) {
  return playbackURL(remoteMediaURL(sourceId, workCode, remotePath), profile, forceTranscode);
}

export function remoteMediaURL(sourceId: number, workCode: string, remotePath: string) {
  const query = new URLSearchParams({ path: remotePath });
  return `/api/remote-sources/${encodeURIComponent(String(sourceId))}/works/${encodeURIComponent(workCode)}/media?${query.toString()}`;
}

export function forcePlaybackTranscodeURL(url: string) {
  if (!url) return "";
  const query = new URLSearchParams({ forceTranscode: "1" });
  return appendQuery(url, query);
}

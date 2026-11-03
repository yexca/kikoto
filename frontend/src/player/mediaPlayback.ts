export type PlaybackProfile = "audio" | "video";

type CapabilitySpec = {
  key: string;
  mime: string;
  /**
   * The decoding configuration of a key that MediaCapabilities must report
   * supported and power efficient, where the browser has it.
   */
  decoding?: Omit<VideoConfiguration, "contentType">;
};

const audioCapabilities: CapabilitySpec[] = [
  { key: "audio-mp3", mime: "audio/mpeg" },
  { key: "audio-mp4-aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { key: "audio-flac", mime: "audio/flac" },
  { key: "audio-ogg-opus", mime: 'audio/ogg; codecs="opus"' },
  { key: "audio-ogg-vorbis", mime: 'audio/ogg; codecs="vorbis"' },
  { key: "audio-webm-opus", mime: 'audio/webm; codecs="opus"' },
  { key: "audio-webm-vorbis", mime: 'audio/webm; codecs="vorbis"' },
  { key: "audio-wav", mime: "audio/wav" },
];

const decodeAt1080p = { width: 1920, height: 1080, bitrate: 10_000_000, framerate: 30 };
const decodeAt2160p = { width: 3840, height: 2160, bitrate: 40_000_000, framerate: 30 };

// Container keys pair a codec with an audio codec in a container; decoder keys
// name the profile, level, and bit depth the browser decodes. The backend
// matches a probed file against both, as media_direct_video.go describes.
const videoCapabilities: CapabilitySpec[] = [
  { key: "video-mp4-h264-aac", mime: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' },
  { key: "video-mp4-h264-mp3", mime: 'video/mp4; codecs="avc1.42E01E, mp3"' },
  { key: "video-mp4-h264-noaudio", mime: 'video/mp4; codecs="avc1.42E01E"' },
  { key: "video-mp4-hvc1-aac", mime: 'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"' },
  { key: "video-mp4-hvc1-noaudio", mime: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  { key: "video-mp4-hev1-aac", mime: 'video/mp4; codecs="hev1.1.6.L93.B0, mp4a.40.2"' },
  { key: "video-mp4-hev1-noaudio", mime: 'video/mp4; codecs="hev1.1.6.L93.B0"' },
  { key: "video-mp4-av1-aac", mime: 'video/mp4; codecs="av01.0.04M.08, mp4a.40.2"' },
  { key: "video-mp4-av1-noaudio", mime: 'video/mp4; codecs="av01.0.04M.08"' },
  { key: "video-webm-vp8-opus", mime: 'video/webm; codecs="vp8, opus"' },
  { key: "video-webm-vp8-vorbis", mime: 'video/webm; codecs="vp8, vorbis"' },
  { key: "video-webm-vp8-noaudio", mime: 'video/webm; codecs="vp8"' },
  { key: "video-webm-vp9-opus", mime: 'video/webm; codecs="vp9, opus"' },
  { key: "video-webm-vp9-vorbis", mime: 'video/webm; codecs="vp9, vorbis"' },
  { key: "video-webm-vp9-noaudio", mime: 'video/webm; codecs="vp9"' },
  { key: "video-webm-av1-opus", mime: 'video/webm; codecs="av01.0.04M.08, opus"' },
  { key: "video-webm-av1-noaudio", mime: 'video/webm; codecs="av01.0.04M.08"' },
  { key: "video-mkv-h264-aac", mime: 'video/x-matroska; codecs="avc1.42E01E, mp4a.40.2"' },
  { key: "video-mkv-h264-opus", mime: 'video/x-matroska; codecs="avc1.42E01E, opus"' },
  { key: "video-mkv-h264-noaudio", mime: 'video/x-matroska; codecs="avc1.42E01E"' },
  { key: "video-mkv-vp9-aac", mime: 'video/x-matroska; codecs="vp9, mp4a.40.2"' },
  { key: "video-h264-main", mime: 'video/mp4; codecs="avc1.4D401F"' },
  { key: "video-h264-high", mime: 'video/mp4; codecs="avc1.64002A"' },
  { key: "video-h264-high-l52", mime: 'video/mp4; codecs="avc1.640034"' },
  { key: "video-hevc-main", mime: 'video/mp4; codecs="hvc1.1.6.L123.B0"', decoding: decodeAt1080p },
  { key: "video-hevc-main-l51", mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"', decoding: decodeAt2160p },
  { key: "video-hevc-main10", mime: 'video/mp4; codecs="hvc1.2.4.L123.B0"', decoding: decodeAt1080p },
  { key: "video-hevc-main10-l51", mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"', decoding: decodeAt2160p },
  { key: "video-av1-main", mime: 'video/mp4; codecs="av01.0.09M.08"', decoding: decodeAt1080p },
  { key: "video-av1-main-l51", mime: 'video/mp4; codecs="av01.0.13M.08"', decoding: decodeAt2160p },
  { key: "video-av1-main10", mime: 'video/mp4; codecs="av01.0.09M.10"', decoding: decodeAt1080p },
  { key: "video-av1-main10-l51", mime: 'video/mp4; codecs="av01.0.13M.10"', decoding: decodeAt2160p },
  { key: "video-vp9-profile2", mime: 'video/webm; codecs="vp09.02.10.10"' },
];

// HEVC decoder keys for HLS segments, which hls.js plays through Media Source
// Extensions. Each mirrors a decoder key above but is probed against Media
// Source, because a browser can decode HEVC there and not as a file, or the
// reverse.
const hlsVideoCapabilities: CapabilitySpec[] = [
  { key: "video-hls-hevc-main", mime: 'video/mp4; codecs="hvc1.1.6.L123.B0"', decoding: decodeAt1080p },
  { key: "video-hls-hevc-main-l51", mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"', decoding: decodeAt2160p },
  { key: "video-hls-hevc-main10", mime: 'video/mp4; codecs="hvc1.2.4.L123.B0"', decoding: decodeAt1080p },
  { key: "video-hls-hevc-main10-l51", mime: 'video/mp4; codecs="hvc1.2.4.L153.B0"', decoding: decodeAt2160p },
];

function capabilitySpecs(profile: PlaybackProfile) {
  return profile === "audio" ? audioCapabilities : videoCapabilities;
}

function playbackElement(profile: PlaybackProfile) {
  if (typeof document === "undefined") return null;
  const element = document.createElement(profile);
  return typeof element.canPlayType === "function" ? element : null;
}

function canPlay(element: HTMLMediaElement, mime: string) {
  try {
    return element.canPlayType(mime) !== "";
  } catch {
    return false;
  }
}

function mediaCapabilities() {
  const capabilities = typeof navigator === "undefined" ? undefined : navigator.mediaCapabilities;
  return typeof capabilities?.decodingInfo === "function" ? capabilities : null;
}

/**
 * The capabilities the media element reports synchronously. A key that needs
 * MediaCapabilities is left out where the browser has it, because only
 * {@link videoPlaybackCapabilities} can wait for its answer.
 */
export function playbackCapabilities(profile: PlaybackProfile): string[] {
  const element = playbackElement(profile);
  if (!element) return [];
  const verifies = mediaCapabilities() !== null;
  return capabilitySpecs(profile)
    .filter(({ mime, decoding }) => !(decoding && verifies) && canPlay(element, mime))
    .map(({ key }) => key);
}

async function decodesEfficiently(
  capabilities: MediaCapabilities | null,
  type: MediaDecodingType,
  { mime, decoding }: CapabilitySpec,
) {
  if (!decoding || !capabilities) return true;
  try {
    const info = await capabilities.decodingInfo({ type, video: { contentType: mime, ...decoding } });
    return info.supported && info.powerEfficient;
  } catch {
    return false;
  }
}

/**
 * The video capabilities, with HEVC and AV1 decoder keys kept only when
 * MediaCapabilities reports them supported and power efficient. HLS HEVC keys
 * need Media Source support for the codec and AAC, and are measured as Media
 * Source decoding.
 */
export async function videoPlaybackCapabilities(): Promise<string[]> {
  const element = playbackElement("video");
  if (!element) return [];
  const capabilities = mediaCapabilities();
  const mediaSource = mediaSourceSupports('audio/mp4; codecs="mp4a.40.2"');
  const kept = await Promise.all([
    ...videoCapabilities.map(
      async (spec) => canPlay(element, spec.mime) && (await decodesEfficiently(capabilities, "file", spec)),
    ),
    ...hlsVideoCapabilities.map(
      async (spec) =>
        mediaSource && mediaSourceSupports(spec.mime) && (await decodesEfficiently(capabilities, "media-source", spec)),
    ),
  ]);
  return [...videoCapabilities, ...hlsVideoCapabilities].filter((_, index) => kept[index]).map(({ key }) => key);
}

export type AudioHlsPlayback = "native" | "mse";

/**
 * How this browser plays an audio HLS playlist, or null when it cannot. iOS
 * and iPadOS use their native player, which keeps playing on the lock screen;
 * other browsers use Media Source Extensions through hls.js.
 */
export function audioHlsPlayback(): AudioHlsPlayback | null {
  if (typeof document === "undefined") return null;
  let native = false;
  try {
    const element = document.createElement("audio");
    native = typeof element.canPlayType === "function" && element.canPlayType("application/vnd.apple.mpegurl") !== "";
  } catch {
    native = false;
  }
  if (native && appleMobileWebKit()) return "native";
  if (mediaSourceSupports('audio/mp4; codecs="mp4a.40.2"')) return "mse";
  return native ? "native" : null;
}

/**
 * Whether a video element plays an HLS playlist through its own player rather
 * than hls.js: on iOS and iPadOS, which keeps native fullscreen and AirPlay.
 * Other browsers, Android WebView included, use hls.js when it is supported.
 */
export function prefersNativeVideoHls(element: Pick<HTMLMediaElement, "canPlayType">) {
  try {
    return appleMobileWebKit() && element.canPlayType("application/vnd.apple.mpegurl") !== "";
  } catch {
    return false;
  }
}

function appleMobileWebKit() {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports a desktop Mac, which has no touch points.
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Whether the Media Source that hls.js would use accepts mime. */
function mediaSourceSupports(mime: string) {
  const source =
    (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
  try {
    return typeof source?.isTypeSupported === "function" && source.isTypeSupported(mime);
  } catch {
    return false;
  }
}

/**
 * The HLS VOD playlist of a local or cached location. The "audio" profile
 * plays only the audio of a video; the media kind is played otherwise.
 */
export function mediaHlsPlaylistURL(locationId: number, profile?: PlaybackProfile) {
  const url = `/api/media/${encodeURIComponent(String(locationId))}/hls/index.m3u8`;
  return profile ? `${url}?profile=${profile}` : url;
}

function appendQuery(url: string, query: URLSearchParams) {
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const separator = base.includes("?") ? (base.endsWith("?") || base.endsWith("&") ? "" : "&") : "?";
  return `${base}${separator}${query.toString()}${hash}`;
}

export function playbackURL(url: string, profile: PlaybackProfile, forceTranscode = false, forceDirect = false) {
  if (!url) return "";
  const query = new URLSearchParams();
  query.set("profile", profile);
  const capabilities = playbackCapabilities(profile);
  if (capabilities.length > 0) query.set("capabilities", capabilities.join(","));
  if (forceTranscode) query.set("forceTranscode", "1");
  if (forceDirect) query.set("forceDirect", "1");
  return appendQuery(url, query);
}

export function remoteMediaPlaybackURL(
  sourceId: number,
  workCode: string,
  remotePath: string,
  profile: PlaybackProfile,
) {
  return playbackURL(remoteMediaURL(sourceId, workCode, remotePath), profile);
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

export function forcePlaybackDirectURL(url: string) {
  if (!url) return "";
  const query = new URLSearchParams({ forceDirect: "1" });
  return appendQuery(url, query);
}

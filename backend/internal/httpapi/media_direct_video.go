package httpapi

import (
	"slices"
	"strings"
)

// Direct video playback needs two kinds of capability key. A container key,
// video-<container>-<codec>-<audio>, says the browser plays that video and audio
// pairing in that container. A decoder key says the browser decodes the
// stream's profile, level, and bit depth; H.264 Constrained Baseline up to level
// 3.0 and 8-bit VP8/VP9 need only the container key, because the container key
// is probed with those streams.
const (
	capVideoMP4HVC1AAC     = "video-mp4-hvc1-aac"
	capVideoMP4HVC1NoAudio = "video-mp4-hvc1-noaudio"
	capVideoMP4HEV1AAC     = "video-mp4-hev1-aac"
	capVideoMP4HEV1NoAudio = "video-mp4-hev1-noaudio"
	capVideoMP4AV1AAC      = "video-mp4-av1-aac"
	capVideoMP4AV1NoAudio  = "video-mp4-av1-noaudio"
	capVideoWebMAV1Opus    = "video-webm-av1-opus"
	capVideoWebMAV1NoAudio = "video-webm-av1-noaudio"
	capVideoMKVH264AAC     = "video-mkv-h264-aac"
	capVideoMKVH264Opus    = "video-mkv-h264-opus"
	capVideoMKVH264NoAudio = "video-mkv-h264-noaudio"
	capVideoMKVVP9AAC      = "video-mkv-vp9-aac"

	capVideoH264Main      = "video-h264-main"
	capVideoH264High      = "video-h264-high"
	capVideoH264HighL52   = "video-h264-high-l52"
	capVideoHEVCMain      = "video-hevc-main"
	capVideoHEVCMainL51   = "video-hevc-main-l51"
	capVideoHEVCMain10    = "video-hevc-main10"
	capVideoHEVCMain10L51 = "video-hevc-main10-l51"
	capVideoAV1Main       = "video-av1-main"
	capVideoAV1MainL51    = "video-av1-main-l51"
	capVideoAV1Main10     = "video-av1-main10"
	capVideoAV1Main10L51  = "video-av1-main10-l51"
	capVideoVP9Profile2   = "video-vp9-profile2"

	// HEVC decoder keys for HLS segments; see hlsHEVCDecoderCapabilities.
	capVideoHLSHEVCMain      = "video-hls-hevc-main"
	capVideoHLSHEVCMainL51   = "video-hls-hevc-main-l51"
	capVideoHLSHEVCMain10    = "video-hls-hevc-main10"
	capVideoHLSHEVCMain10L51 = "video-hls-hevc-main10-l51"
)

var videoPlaybackCapabilityKeys = []string{
	capVideoMP4H264AAC, capVideoMP4H264MP3, capVideoMP4H264NoAudio,
	capVideoMP4HVC1AAC, capVideoMP4HVC1NoAudio, capVideoMP4HEV1AAC, capVideoMP4HEV1NoAudio,
	capVideoMP4AV1AAC, capVideoMP4AV1NoAudio,
	capVideoWebMVP8Opus, capVideoWebMVP8Vorbis, capVideoWebMVP8NoAudio,
	capVideoWebMVP9Opus, capVideoWebMVP9Vorbis, capVideoWebMVP9NoAudio,
	capVideoWebMAV1Opus, capVideoWebMAV1NoAudio,
	capVideoMKVH264AAC, capVideoMKVH264Opus, capVideoMKVH264NoAudio, capVideoMKVVP9AAC,
	capVideoH264Main, capVideoH264High, capVideoH264HighL52,
	capVideoHEVCMain, capVideoHEVCMainL51, capVideoHEVCMain10, capVideoHEVCMain10L51,
	capVideoAV1Main, capVideoAV1MainL51, capVideoAV1Main10, capVideoAV1Main10L51,
	capVideoVP9Profile2,
	capVideoHLSHEVCMain, capVideoHLSHEVCMainL51, capVideoHLSHEVCMain10, capVideoHLSHEVCMain10L51,
}

// Containers are tried in order: FFprobe names both WebM and Matroska files
// "matroska,webm", and a file whose codecs WebM allows is served as WebM.
var directVideoContainers = []struct {
	name        string
	formats     []string
	contentType string
}{
	{name: "mp4", formats: []string{"mov", "mp4", "m4v", "3gp"}, contentType: "video/mp4"},
	{name: "webm", formats: []string{"webm"}, contentType: "video/webm"},
	{name: "mkv", formats: []string{"matroska"}, contentType: "video/x-matroska"},
}

// videoDecoderTier is one decoder key. A stream fits when its profile is
// listed, its bit depth is at most bitDepth, and its level is at most maxLevel,
// in FFprobe's units for the codec. A stream without a reported level is
// measured by its frame size against maxPixels instead.
type videoDecoderTier struct {
	capability string
	profiles   []string
	bitDepth   int
	maxLevel   int
	maxPixels  int
}

const (
	pixelsLevel30   = 720 * 576
	pixelsLevel31   = 1280 * 720
	pixelsLevel4    = 2048 * 1152
	pixelsLevel5    = 4096 * 2304
	unboundedLevel  = 1 << 30
	unboundedPixels = 1 << 30
)

var (
	h264BaselineProfiles = []string{"", "baseline", "constrained baseline"}
	h264MainProfiles     = append(slices.Clone(h264BaselineProfiles), "main")
	h264HighProfiles     = append(slices.Clone(h264MainProfiles), "high", "constrained high", "progressive high")
)

// Decoder keys are probed with H.264 Main 3.1, High 4.2 and 5.2; HEVC Main and
// Main 10 at levels 4.1 and 5.1; and AV1 Main 8- and 10-bit at levels 4.1 and
// 5.1. FFprobe reports H.264 levels as ten times the level, HEVC levels as
// thirty times, and AV1 levels as seq_level_idx.
var videoDecoderTiers = map[string][]videoDecoderTier{
	"h264": {
		{profiles: h264BaselineProfiles, bitDepth: 8, maxLevel: 30, maxPixels: pixelsLevel30},
		{capability: capVideoH264Main, profiles: h264MainProfiles, bitDepth: 8, maxLevel: 31, maxPixels: pixelsLevel31},
		{capability: capVideoH264High, profiles: h264HighProfiles, bitDepth: 8, maxLevel: 42, maxPixels: pixelsLevel4},
		{capability: capVideoH264HighL52, profiles: h264HighProfiles, bitDepth: 8, maxLevel: 52, maxPixels: pixelsLevel5},
	},
	"hevc": {
		{capability: capVideoHEVCMain, profiles: []string{"main"}, bitDepth: 8, maxLevel: 123, maxPixels: pixelsLevel4},
		{capability: capVideoHEVCMainL51, profiles: []string{"main"}, bitDepth: 8, maxLevel: 153, maxPixels: pixelsLevel5},
		{capability: capVideoHEVCMain10, profiles: []string{"main", "main 10"}, bitDepth: 10, maxLevel: 123, maxPixels: pixelsLevel4},
		{capability: capVideoHEVCMain10L51, profiles: []string{"main", "main 10"}, bitDepth: 10, maxLevel: 153, maxPixels: pixelsLevel5},
	},
	"av1": {
		{capability: capVideoAV1Main, profiles: []string{"main"}, bitDepth: 8, maxLevel: 9, maxPixels: pixelsLevel4},
		{capability: capVideoAV1MainL51, profiles: []string{"main"}, bitDepth: 8, maxLevel: 13, maxPixels: pixelsLevel5},
		{capability: capVideoAV1Main10, profiles: []string{"main"}, bitDepth: 10, maxLevel: 9, maxPixels: pixelsLevel4},
		{capability: capVideoAV1Main10L51, profiles: []string{"main"}, bitDepth: 10, maxLevel: 13, maxPixels: pixelsLevel5},
	},
	"vp8": {
		{bitDepth: 8, maxLevel: unboundedLevel, maxPixels: unboundedPixels},
	},
	"vp9": {
		{profiles: []string{"", "profile 0"}, bitDepth: 8, maxLevel: unboundedLevel, maxPixels: unboundedPixels},
		{capability: capVideoVP9Profile2, profiles: []string{"profile 2"}, bitDepth: 10, maxLevel: unboundedLevel, maxPixels: unboundedPixels},
	},
}

// directVideoContentType returns the content type of a video the browser
// reported it can decode as stored, or false when it must be transcoded.
func directVideoContentType(probe playbackProbe, video *playbackProbeStream, audioCodec string, capabilities map[string]bool) (string, bool) {
	codec := strings.ToLower(strings.TrimSpace(video.CodecName))
	if !videoDecoderSupported(video, codec, capabilities) {
		return "", false
	}
	family := codec
	if codec == "hevc" {
		// Browsers that play HEVC in MP4 differ on the hvc1 and hev1 sample entries.
		family = strings.ToLower(strings.TrimSpace(video.CodecTag))
	}
	for _, container := range directVideoContainers {
		if !slices.ContainsFunc(container.formats, func(name string) bool { return playbackFormatIncludes(probe, name) }) {
			continue
		}
		if capabilities["video-"+container.name+"-"+family+"-"+audioCodec] {
			return container.contentType, true
		}
	}
	return "", false
}

func videoDecoderSupported(video *playbackProbeStream, codec string, capabilities map[string]bool) bool {
	depth, ok := videoBitDepth(video.PixelFmt)
	if !ok {
		return false
	}
	profile := strings.ToLower(strings.TrimSpace(video.Profile))
	for _, tier := range videoDecoderTiers[codec] {
		if tier.capability != "" && !capabilities[tier.capability] {
			continue
		}
		if tier.profiles != nil && !slices.Contains(tier.profiles, profile) {
			continue
		}
		if depth > tier.bitDepth {
			continue
		}
		if video.Level > 0 {
			if video.Level <= tier.maxLevel {
				return true
			}
			continue
		}
		if video.Width*video.Height <= tier.maxPixels {
			return true
		}
	}
	return false
}

// videoBitDepth accepts only 4:2:0 pixel formats, which every browser decoder
// renders; 4:2:2, 4:4:4, and 12-bit video is transcoded. An unreported pixel
// format is treated as 8-bit.
func videoBitDepth(pixelFormat string) (int, bool) {
	switch strings.ToLower(strings.TrimSpace(pixelFormat)) {
	case "", "yuv420p", "yuvj420p":
		return 8, true
	case "yuv420p10le", "yuv420p10be":
		return 10, true
	}
	return 0, false
}

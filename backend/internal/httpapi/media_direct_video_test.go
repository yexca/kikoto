package httpapi

import (
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

const (
	formatMP4      = "mov,mp4,m4a,3gp,3g2,mj2"
	formatMatroska = "matroska,webm"
)

func directVideoProbe(format string, video playbackProbeStream, audioCodec string) playbackProbe {
	video.CodecType = "video"
	probe := playbackProbe{Format: playbackProbeFormat{FormatName: format}, Streams: []playbackProbeStream{video}}
	if audioCodec != "" {
		probe.Streams = append(probe.Streams, playbackProbeStream{CodecType: "audio", CodecName: audioCodec})
	}
	return probe
}

func TestDirectVideoPlaybackMatchesContainerAndDecoderCapabilities(t *testing.T) {
	h264 := func(profile string, level int, pixelFormat string) playbackProbeStream {
		return playbackProbeStream{CodecName: "h264", CodecTag: "avc1", Profile: profile, Level: level, PixelFmt: pixelFormat, Width: 1920, Height: 1080}
	}
	hevc := func(tag string, profile string, level int, pixelFormat string) playbackProbeStream {
		return playbackProbeStream{CodecName: "hevc", CodecTag: tag, Profile: profile, Level: level, PixelFmt: pixelFormat, Width: 1920, Height: 1080}
	}
	av1 := func(profile string, level int, pixelFormat string, width int, height int) playbackProbeStream {
		return playbackProbeStream{CodecName: "av1", Profile: profile, Level: level, PixelFmt: pixelFormat, Width: width, Height: height}
	}
	vp9 := func(profile string, pixelFormat string) playbackProbeStream {
		return playbackProbeStream{CodecName: "vp9", Profile: profile, Level: -99, PixelFmt: pixelFormat, Width: 1920, Height: 1080}
	}
	cases := []struct {
		name         string
		probe        playbackProbe
		capabilities []string
		want         string
	}{
		{
			name:         "h264 constrained baseline needs only the container key",
			probe:        directVideoProbe(formatMP4, h264("Constrained Baseline", 30, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4H264AAC},
			want:         "video/mp4",
		},
		{
			name:         "h264 high without a decoder key",
			probe:        directVideoProbe(formatMP4, h264("High", 40, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4H264AAC},
		},
		{
			name:         "h264 high 4.0 with the high key",
			probe:        directVideoProbe(formatMP4, h264("High", 40, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4H264AAC, capVideoH264High},
			want:         "video/mp4",
		},
		{
			name:         "h264 main 4.0 above the main key level",
			probe:        directVideoProbe(formatMP4, h264("Main", 40, "yuv420p"), "noaudio"),
			capabilities: []string{capVideoMP4H264NoAudio, capVideoH264Main},
		},
		{
			name:         "h264 main 3.1 with the main key",
			probe:        directVideoProbe(formatMP4, h264("Main", 31, "yuvj420p"), ""),
			capabilities: []string{capVideoMP4H264NoAudio, capVideoH264Main},
			want:         "video/mp4",
		},
		{
			name:         "h264 high 5.1 above the high key level",
			probe:        directVideoProbe(formatMP4, h264("High", 51, "yuv420p"), "mp3"),
			capabilities: []string{capVideoMP4H264MP3, capVideoH264High},
		},
		{
			name:         "h264 high 5.1 with the level 5.2 key",
			probe:        directVideoProbe(formatMP4, h264("High", 51, "yuv420p"), "mp3"),
			capabilities: []string{capVideoMP4H264MP3, capVideoH264HighL52},
			want:         "video/mp4",
		},
		{
			name:         "h264 10-bit transcodes",
			probe:        directVideoProbe(formatMP4, h264("High 10", 40, "yuv420p10le"), "aac"),
			capabilities: []string{capVideoMP4H264AAC, capVideoH264High, capVideoH264HighL52},
		},
		{
			name:         "h264 4:4:4 transcodes",
			probe:        directVideoProbe(formatMP4, h264("High 4:4:4 Predictive", 40, "yuv444p"), "aac"),
			capabilities: []string{capVideoMP4H264AAC, capVideoH264High, capVideoH264HighL52},
		},
		{
			name:         "hevc hvc1 main",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main", 120, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain},
			want:         "video/mp4",
		},
		{
			name:         "hevc without a decoder key",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main", 120, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC},
		},
		{
			name:         "hevc hev1 needs the hev1 container key",
			probe:        directVideoProbe(formatMP4, hevc("hev1", "Main", 120, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain},
		},
		{
			name:         "hevc hev1 with the hev1 container key",
			probe:        directVideoProbe(formatMP4, hevc("hev1", "Main", 120, "yuv420p"), ""),
			capabilities: []string{capVideoMP4HEV1NoAudio, capVideoHEVCMain},
			want:         "video/mp4",
		},
		{
			name:         "hevc main 10 needs a main 10 key",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main 10", 120, "yuv420p10le"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain, capVideoHEVCMainL51},
		},
		{
			name:         "hevc main 10 with the main 10 key",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main 10", 120, "yuv420p10le"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain10},
			want:         "video/mp4",
		},
		{
			name:         "hevc main 10 level 5.1 above the main 10 key level",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main 10", 153, "yuv420p10le"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain10},
		},
		{
			name:         "hevc main 10 level 5.1 with the level 5.1 key",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Main 10", 153, "yuv420p10le"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain10L51},
			want:         "video/mp4",
		},
		{
			name:         "hevc range extension 4:4:4 transcodes",
			probe:        directVideoProbe(formatMP4, hevc("hvc1", "Rext", 120, "yuv444p"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoHEVCMain, capVideoHEVCMain10, capVideoHEVCMainL51, capVideoHEVCMain10L51},
		},
		{
			name:         "hevc in matroska transcodes",
			probe:        directVideoProbe(formatMatroska, hevc("[0][0][0][0]", "Main", 120, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4HVC1AAC, capVideoMP4HEV1AAC, capVideoMKVH264AAC, capVideoHEVCMain},
		},
		{
			name:         "av1 in mp4",
			probe:        directVideoProbe(formatMP4, av1("Main", 8, "yuv420p", 1920, 1080), "aac"),
			capabilities: []string{capVideoMP4AV1AAC, capVideoAV1Main},
			want:         "video/mp4",
		},
		{
			name:         "av1 10-bit needs a 10-bit key",
			probe:        directVideoProbe(formatMatroska, av1("Main", 8, "yuv420p10le", 1920, 1080), "opus"),
			capabilities: []string{capVideoWebMAV1Opus, capVideoAV1Main, capVideoAV1MainL51},
		},
		{
			name:         "av1 10-bit in webm with the 10-bit key",
			probe:        directVideoProbe(formatMatroska, av1("Main", 8, "yuv420p10le", 1920, 1080), "opus"),
			capabilities: []string{capVideoWebMAV1Opus, capVideoAV1Main10},
			want:         "video/webm",
		},
		{
			name:         "av1 without a reported level is measured by frame size",
			probe:        directVideoProbe(formatMatroska, av1("Main", -99, "yuv420p", 3840, 2160), ""),
			capabilities: []string{capVideoWebMAV1NoAudio, capVideoAV1Main},
		},
		{
			name:         "av1 4k without a reported level with the level 5.1 key",
			probe:        directVideoProbe(formatMatroska, av1("Main", -99, "yuv420p", 3840, 2160), ""),
			capabilities: []string{capVideoWebMAV1NoAudio, capVideoAV1MainL51},
			want:         "video/webm",
		},
		{
			name:         "av1 high profile 4:4:4 transcodes",
			probe:        directVideoProbe(formatMP4, av1("High", 8, "yuv444p", 1920, 1080), "aac"),
			capabilities: []string{capVideoMP4AV1AAC, capVideoAV1Main, capVideoAV1Main10},
		},
		{
			name:         "h264 in matroska with the matroska key",
			probe:        directVideoProbe(formatMatroska, h264("High", 41, "yuv420p"), "aac"),
			capabilities: []string{capVideoMKVH264AAC, capVideoH264High},
			want:         "video/x-matroska",
		},
		{
			name:         "h264 in matroska without the matroska key",
			probe:        directVideoProbe(formatMatroska, h264("High", 41, "yuv420p"), "aac"),
			capabilities: []string{capVideoMP4H264AAC, capVideoH264High},
		},
		{
			name:         "vp9 with webm codecs in matroska is served as webm",
			probe:        directVideoProbe(formatMatroska, vp9("Profile 0", "yuv420p"), "opus"),
			capabilities: []string{capVideoWebMVP9Opus, capVideoMKVVP9AAC},
			want:         "video/webm",
		},
		{
			name:         "vp9 with aac in matroska",
			probe:        directVideoProbe(formatMatroska, vp9("Profile 0", "yuv420p"), "aac"),
			capabilities: []string{capVideoWebMVP9Opus, capVideoMKVVP9AAC},
			want:         "video/x-matroska",
		},
		{
			name:         "vp9 profile 2 needs the profile 2 key",
			probe:        directVideoProbe(formatMatroska, vp9("Profile 2", "yuv420p10le"), "opus"),
			capabilities: []string{capVideoWebMVP9Opus},
		},
		{
			name:         "vp9 profile 2 with the profile 2 key",
			probe:        directVideoProbe(formatMatroska, vp9("Profile 2", "yuv420p10le"), "opus"),
			capabilities: []string{capVideoWebMVP9Opus, capVideoVP9Profile2},
			want:         "video/webm",
		},
		{
			name:         "vp9 4:4:4 transcodes",
			probe:        directVideoProbe(formatMatroska, vp9("Profile 1", "yuv444p"), "opus"),
			capabilities: []string{capVideoWebMVP9Opus, capVideoVP9Profile2},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			capabilities := make(map[string]bool)
			for _, capability := range testCase.capabilities {
				capabilities[capability] = true
			}
			contentType, ok := directPlaybackContentType(testCase.probe, playbackProfileVideo, capabilities)
			if ok != (testCase.want != "") || contentType != testCase.want {
				t.Fatalf("direct video = %q/%t, want %q", contentType, ok, testCase.want)
			}
		})
	}
}

func TestPlaybackCapabilitiesKeepEveryKnownVideoKey(t *testing.T) {
	values := append(slices.Clone(videoPlaybackCapabilityKeys), "video-mp4-h264-flac", "", " AUDIO-MP3 ")
	query := url.Values{"capabilities": []string{strings.Join(values, ",")}}
	request := httptest.NewRequest("GET", "/api/media/1/playback?"+query.Encode(), nil)
	capabilities := playbackCapabilities(request)
	if len(capabilities) != len(videoPlaybackCapabilityKeys)+1 {
		t.Fatalf("capabilities = %d keys, want every video key and audio-mp3", len(capabilities))
	}
	if !capabilities[capVideoAV1Main10L51] || !capabilities[capAudioMP3] || capabilities["video-mp4-h264-flac"] {
		t.Fatalf("capabilities = %v", capabilities)
	}
}

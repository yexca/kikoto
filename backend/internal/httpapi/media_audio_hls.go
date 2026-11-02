package httpapi

import (
	"strconv"
)

// Audio HLS encodes run far ahead of the listener, because a 192 kbit/s AAC
// encode is much faster than playback and its segments are small; even a
// multi-hour file starts within about a second.
const (
	audioHLSProfileVersion  = "hls-audio-v1-aac192"
	audioHLSSessionPlaylist = ".audio-hls-session.m3u8"
	// The audio of a video has its own revisions, so its segments never mix
	// with the video sessions of the same file.
	videoAudioHLSProfileVersion = "hls-video-audio-v1-aac192"
)

var audioHLSProfile = hlsEncodeProfile{
	name:     "audio-hls",
	cacheDir: "hls-audio",
	playlist: audioHLSSessionPlaylist,
	// Thirty minutes ahead of the listener, refilled ten minutes before a gap.
	aheadSegments:       300,
	refillLeadSegments:  100,
	waitWindowSegments:  20,
	maximumSegments:     300 + 100,
	segmentMaximumBytes: hlsSegmentMaximumBytes,
	// A 192 kbit/s six-second segment is about 170 KiB in MPEG-TS.
	reservation: fixedHLSSegmentReservation(300+100, 256<<10),
	args: func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return audioHLSFFmpegArgs(source.Path, outputDir, startIndex)
	},
}

// videoAudioHLSProfile plays the first audio stream of a video in the audio
// player with the audio encode. The video is never decoded.
var videoAudioHLSProfile = hlsEncodeProfile{
	name:                "video-audio-hls",
	cacheDir:            audioHLSProfile.cacheDir,
	playlist:            audioHLSSessionPlaylist,
	aheadSegments:       audioHLSProfile.aheadSegments,
	refillLeadSegments:  audioHLSProfile.refillLeadSegments,
	waitWindowSegments:  audioHLSProfile.waitWindowSegments,
	maximumSegments:     audioHLSProfile.maximumSegments,
	segmentMaximumBytes: audioHLSProfile.segmentMaximumBytes,
	reservation:         audioHLSProfile.reservation,
	args: func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return videoAudioHLSFFmpegArgs(source.Path, outputDir, startIndex, source.Duration)
	},
}

// videoAudioHLSFFmpegArgs pads the audio with silence to the published
// duration of the video, so an audio stream that ends before the video still
// produces every segment of the playlist.
func videoAudioHLSFFmpegArgs(input string, outputDir string, startIndex int, durationSeconds float64) []string {
	start := float64(startIndex) * hlsSegmentDurationSeconds
	return audioHLSFFmpegArgs(input, outputDir, startIndex,
		"-af", "apad", "-t", strconv.FormatFloat(durationSeconds-start, 'f', 3, 64))
}

func audioHLSFFmpegArgs(input string, outputDir string, startIndex int, outputOptions ...string) []string {
	start := strconv.FormatFloat(float64(startIndex)*hlsSegmentDurationSeconds, 'f', 3, 64)
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "1", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-ss", start, "-i", input,
		"-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
	}
	args = append(args, outputOptions...)
	args = append(args,
		"-c:a", "aac", "-threads:a", "1", "-b:a", "192k", "-ac", "2", "-ar", "48000",
		// Every session writes the timestamps of one shared timeline.
		"-output_ts_offset", start,
		"-muxdelay", "0", "-muxpreload", "0",
	)
	return append(args, hlsSegmentFFmpegOutputArgs(outputDir, audioHLSSessionPlaylist, startIndex)...)
}

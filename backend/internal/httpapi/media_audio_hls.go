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

func audioHLSFFmpegArgs(input string, outputDir string, startIndex int) []string {
	start := strconv.FormatFloat(float64(startIndex)*hlsSegmentDurationSeconds, 'f', 3, 64)
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "1", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-ss", start, "-i", input,
		"-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
		"-c:a", "aac", "-threads:a", "1", "-b:a", "192k", "-ac", "2", "-ar", "48000",
		// Every session writes the timestamps of one shared timeline.
		"-output_ts_offset", start,
		"-muxdelay", "0", "-muxpreload", "0",
	}
	return append(args, hlsSegmentFFmpegOutputArgs(outputDir, audioHLSSessionPlaylist, startIndex)...)
}

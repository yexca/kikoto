package httpapi

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// A video viewer plays one audio stream of the file. Without a choice it plays
// the default track: the first audio stream marked default, or the first audio
// stream when none is. Every encode of a track other than the first has its own
// revision, so its segments, cache directory, and derived remux and hardware
// revisions never mix with those of another track.
const (
	videoAudioTrackRevisionVersion = "video-audio-track-v1"
	// videoAudioStreamQuery names the chosen audio stream by its index among
	// all streams of the file, as FFprobe reports it.
	videoAudioStreamQuery = "audioStream"
)

var errInvalidVideoAudioStream = errors.New("video audio stream is invalid")

type playbackProbeDisposition struct {
	Default int `json:"default"`
}

type playbackProbeTags struct {
	Language string `json:"language"`
	Title    string `json:"title"`
}

// videoAudioTrack describes one audio stream of a video in playback info.
type videoAudioTrack struct {
	// StreamIndex is the stream's index in the file, which audioStream names.
	StreamIndex int    `json:"streamIndex"`
	Codec       string `json:"codec"`
	Channels    int    `json:"channels,omitempty"`
	Language    string `json:"language,omitempty"`
	Title       string `json:"title,omitempty"`
	// Default reports the file's default flag.
	Default bool `json:"default"`
}

// videoAudioTracks lists the audio streams of a probe in file order; the
// position in the list is the track number FFmpeg maps as 0:a:N.
func videoAudioTracks(probe playbackProbe) []videoAudioTrack {
	var tracks []videoAudioTrack
	for _, stream := range probe.Streams {
		if !strings.EqualFold(strings.TrimSpace(stream.CodecType), "audio") {
			continue
		}
		language := strings.TrimSpace(stream.Tags.Language)
		if strings.EqualFold(language, "und") {
			language = ""
		}
		tracks = append(tracks, videoAudioTrack{
			StreamIndex: stream.StreamIndex,
			Codec:       strings.TrimSpace(stream.CodecName),
			Channels:    stream.Channels,
			Language:    language,
			Title:       strings.TrimSpace(stream.Tags.Title),
			Default:     stream.Disposition.Default != 0,
		})
	}
	return tracks
}

// defaultVideoAudioTrack returns the track number a video plays without a
// choice.
func defaultVideoAudioTrack(tracks []videoAudioTrack) int {
	for number, track := range tracks {
		if track.Default {
			return number
		}
	}
	return 0
}

// requestedVideoAudioTrack returns the track number the request names with
// audioStream, or the default track when it names none.
func requestedVideoAudioTrack(r *http.Request, tracks []videoAudioTrack) (int, error) {
	value, named := r.URL.Query()[videoAudioStreamQuery]
	if !named {
		return defaultVideoAudioTrack(tracks), nil
	}
	if len(value) != 1 {
		return 0, errInvalidVideoAudioStream
	}
	streamIndex, err := strconv.Atoi(strings.TrimSpace(value[0]))
	if err != nil || streamIndex < 0 {
		return 0, errInvalidVideoAudioStream
	}
	for number, track := range tracks {
		if track.StreamIndex == streamIndex {
			return number, nil
		}
	}
	return 0, errInvalidVideoAudioStream
}

// useAudioTrack makes a video source's encodes map track number track, and
// gives every track but the first a revision of its own.
func (source *hlsPlaybackSource) useAudioTrack(track int) {
	if source.FileRevision == "" {
		source.FileRevision = source.Revision
	}
	source.AudioTrack = track
	source.Revision = source.FileRevision
	if track > 0 {
		revision := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", videoAudioTrackRevisionVersion, track, source.FileRevision)))
		source.Revision = fmt.Sprintf("%x", revision[:12])
	}
}

// selectVideoAudioTrack applies the audio track a request names to a video
// source, or the default track. Other profiles accept no audioStream and keep
// the first audio stream.
func selectVideoAudioTrack(r *http.Request, source *hlsPlaybackSource) error {
	if source.Profile != playbackProfileVideo {
		if r.URL.Query().Has(videoAudioStreamQuery) {
			return errInvalidVideoAudioStream
		}
		return nil
	}
	track, err := requestedVideoAudioTrack(r, videoAudioTracks(source.Probe))
	if err != nil {
		return err
	}
	source.useAudioTrack(track)
	return nil
}

// videoKeyframeIndexKey keys the keyframe index, which depends on the video
// stream alone, so every audio track shares one scan.
func videoKeyframeIndexKey(source hlsPlaybackSource) string {
	if source.FileRevision != "" {
		return source.FileRevision
	}
	return source.Revision
}

// withVideoAudioTrack rewrites the first-audio-stream map of FFmpeg arguments
// to the source's audio track.
func withVideoAudioTrack(args []string, track int) []string {
	if track <= 0 {
		return args
	}
	for index := 1; index < len(args); index++ {
		if args[index-1] == "-map" && args[index] == "0:a:0?" {
			args[index] = "0:a:" + strconv.Itoa(track) + "?"
		}
	}
	return args
}

func writeInvalidVideoAudioStream(w http.ResponseWriter) {
	writeAPIError(w, http.StatusBadRequest, "invalid_audio_stream", "audio stream is invalid", false)
}

// videoAudioTrackQuery is the audioStream query an HLS URL of playback info
// carries, which names a track other than the default; the default track needs
// none.
func videoAudioTrackQuery(tracks []videoAudioTrack, track int) string {
	if track == defaultVideoAudioTrack(tracks) || track >= len(tracks) {
		return ""
	}
	return "&" + videoAudioStreamQuery + "=" + strconv.Itoa(tracks[track].StreamIndex)
}

// selectedVideoAudioStream returns the stream index of track number track, or
// nil for a video without audio.
func selectedVideoAudioStream(tracks []videoAudioTrack, track int) *int {
	if track < 0 || track >= len(tracks) {
		return nil
	}
	return &tracks[track].StreamIndex
}

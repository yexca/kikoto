package record

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/yexca/kikoto/backend/internal/timedtext"
)

// SubtitleMaxBytes bounds a sidecar subtitle the API reads and converts.
const SubtitleMaxBytes = 2 << 20

// ErrSubtitleUnsupported means a sidecar is not served: a format other than
// WebVTT or SubRip, text that is not UTF-8, or a WebVTT file without its
// header.
var ErrSubtitleUnsupported = errors.New("record subtitle is not supported")

// ServesSubtitle reports whether the subtitle route serves a sidecar with this name.
func ServesSubtitle(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".vtt", ".srt":
		return true
	}
	return false
}

// SubtitleToWebVTT returns a WebVTT or SubRip sidecar as WebVTT. A WebVTT
// file passes through after its header is checked; SubRip cues get a WebVTT
// header, dotted milliseconds, and no cue numbers, as timedtext writes them.
func SubtitleToWebVTT(name string, data []byte) ([]byte, error) {
	if len(data) > SubtitleMaxBytes {
		return nil, ErrSubtitleUnsupported
	}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(data) {
		return nil, ErrSubtitleUnsupported
	}
	text := strings.ReplaceAll(strings.ReplaceAll(string(data), "\r\n", "\n"), "\r", "\n")
	switch strings.ToLower(filepath.Ext(name)) {
	case ".vtt":
		if text != "WEBVTT" && !strings.HasPrefix(text, "WEBVTT\n") && !strings.HasPrefix(text, "WEBVTT ") && !strings.HasPrefix(text, "WEBVTT\t") {
			return nil, ErrSubtitleUnsupported
		}
		return []byte(text), nil
	case ".srt":
		return []byte(timedtext.SubRipToWebVTT(text)), nil
	}
	return nil, ErrSubtitleUnsupported
}

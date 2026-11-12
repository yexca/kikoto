package record

import (
	"bytes"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// SubtitleMaxBytes bounds a sidecar subtitle the API reads and converts.
const SubtitleMaxBytes = 2 << 20

// ErrSubtitleUnsupported means a sidecar is not served: a format other than
// WebVTT or SubRip, text that is not UTF-8, or a WebVTT file without its
// header.
var ErrSubtitleUnsupported = errors.New("record subtitle is not supported")

var srtTimingLine = regexp.MustCompile(`^(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{1,3})(.*)$`)

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
// header, dotted milliseconds, and no cue numbers.
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
		return []byte(srtToWebVTT(text)), nil
	}
	return nil, ErrSubtitleUnsupported
}

func srtToWebVTT(text string) string {
	var out strings.Builder
	out.WriteString("WEBVTT\n")
	for _, block := range strings.Split(strings.TrimSpace(text), "\n\n") {
		lines := strings.Split(strings.Trim(block, "\n"), "\n")
		timing := -1
		for index, line := range lines {
			if srtTimingLine.MatchString(strings.TrimSpace(line)) {
				timing = index
				break
			}
		}
		if timing < 0 {
			continue
		}
		match := srtTimingLine.FindStringSubmatch(strings.TrimSpace(lines[timing]))
		out.WriteString("\n")
		out.WriteString(vttTimestamp(match[1], match[2]) + " --> " + vttTimestamp(match[3], match[4]) + "\n")
		for _, line := range lines[timing+1:] {
			// A blank line would end the cue; "-->" would start a new one.
			line = strings.ReplaceAll(line, "-->", "->")
			if strings.TrimSpace(line) == "" {
				continue
			}
			out.WriteString(line + "\n")
		}
	}
	return out.String()
}

func vttTimestamp(clock, millis string) string {
	if len(clock) == 7 {
		clock = "0" + clock
	}
	for len(millis) < 3 {
		millis += "0"
	}
	return clock + "." + millis
}

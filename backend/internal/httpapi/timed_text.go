package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/timedtext"
)

// A text route answers in one of these shapes when its `format` query asks.
// Without `format` it returns the decoded text itself.
const (
	textFormatLyrics = "lyrics"
	textFormatWebVTT = "webvtt"
)

// requestedTextFormat reads the `format` query of a text route: "" for the
// text as it is, or one of the timed-text formats. ok is false for any other.
func requestedTextFormat(r *http.Request) (format string, ok bool) {
	format = r.URL.Query().Get("format")
	return format, format == "" || format == textFormatLyrics || format == textFormatWebVTT
}

// timedLyricsResponse is a lyrics file read as timed lines. Lines are in start
// order with their times in seconds; the client keeps only the active-line
// lookup, the listener's offset, and display.
type timedLyricsResponse struct {
	Timed bool              `json:"timed"`
	Lines []timedLyricsLine `json:"lines"`
	Tags  []timedLyricsTag  `json:"tags"`
	// Sparse reports a file where only a few lines carry LRC timestamps, which
	// a viewer that shows lyrics treats as plain text.
	Sparse bool `json:"sparse"`
	// Text is the file itself when it holds no timed line, for a viewer that
	// shows it as plain text. A client that sent the text already holds it.
	Text string `json:"text,omitempty"`
}

type timedLyricsLine struct {
	Time float64 `json:"time"`
	Text string  `json:"text"`
	// Attribution marks the line naming the models that wrote the file, which
	// is not one of its lyrics.
	Attribution bool `json:"attribution,omitempty"`
}

type timedLyricsTag struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func timedLyrics(text string) timedLyricsResponse {
	parsed := timedtext.ParseLyrics(text)
	response := timedLyricsResponse{
		Timed:  parsed.Timed,
		Lines:  make([]timedLyricsLine, len(parsed.Lines)),
		Tags:   make([]timedLyricsTag, len(parsed.Tags)),
		Sparse: parsed.Sparse,
	}
	for i, line := range parsed.Lines {
		response.Lines[i] = timedLyricsLine{
			Time:        float64(line.TimeMS) / 1000,
			Text:        line.Text,
			Attribution: llm.IsAttribution(line.Text),
		}
	}
	for i, tag := range parsed.Tags {
		response.Tags[i] = timedLyricsTag{Key: tag.Key, Value: tag.Value}
	}
	return response
}

// writeTimedText answers a text route with its decoded text read in a
// timed-text format: timed lyrics as JSON, or a subtitle as WebVTT. A subtitle
// with no cue is unprocessable.
func writeTimedText(w http.ResponseWriter, text, format string) {
	if format == textFormatLyrics {
		response := timedLyrics(text)
		if !response.Timed {
			response.Text = text
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	vtt, ok := timedtext.SubtitleToWebVTT(text)
	if !ok {
		writeAPIError(w, http.StatusUnprocessableEntity, "subtitle_has_no_cues", "the subtitle holds no cue", false)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(vtt))
}

// parseLyricsText reads text a client already holds, such as a translation or
// a transcription that is not a library file, as timed lyrics. It keeps
// nothing and reads no file, so any signed-in viewer may ask, Demo included.
func (s *Server) parseLyricsText(w http.ResponseWriter, r *http.Request) {
	if _, ok := userFromContext(r.Context()); !ok {
		writeAPIError(w, http.StatusUnauthorized, "authentication_required", "login required", false)
		return
	}
	var payload struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*maxTextPreviewBytes)).Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	if len(payload.Text) > maxTextPreviewBytes {
		writeError(w, errTextPreviewTooLarge)
		return
	}
	writeJSON(w, http.StatusOK, timedLyrics(payload.Text))
}

// demoLyricsParseRequest is a read despite its POST transport: the text comes
// from the viewer and nothing is stored.
func demoLyricsParseRequest(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.Path == "/api/lyrics/parse"
}

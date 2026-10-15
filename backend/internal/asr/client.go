package asr

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
)

// ResponseLimit bounds one buffered transcription or model-list response.
const ResponseLimit = 4 << 20

// ErrNoTimestamps reports a service that returned text without the segment
// timestamps lyrics need, such as a model without verbose JSON output.
var ErrNoTimestamps = errors.New("speech recognition response has no segment timestamps")

// UpstreamError is a rejected request. Code is the error code a Kikoto Helper
// reports, and empty for every other service.
type UpstreamError struct {
	Status int
	Code   string
}

func (e UpstreamError) Error() string { return "speech recognition service rejected the request" }

type Client struct {
	HTTP     *http.Client
	Provider Provider
	Host     string
}

// Segment is one timed passage of a transcription, in seconds from the start
// of the submitted audio.
type Segment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type Transcript struct {
	Language string
	Segments []Segment
}

func (c Client) url(suffix string) string {
	return c.Provider.Endpoint(c.Host) + apiPrefix + suffix
}

func (c Client) authorize(req *http.Request) {
	if c.Provider.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.Provider.APIKey)
	}
}

func (c Client) do(req *http.Request) ([]byte, error) {
	req.Header.Set("Accept", "application/json")
	c.authorize(req)
	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		rejected := UpstreamError{Status: response.StatusCode}
		if c.Provider.Preset().Kind == kikotohelper.Kind {
			data, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
			rejected.Code = kikotohelper.ErrorCode(data)
		}
		return nil, rejected
	}
	if response.ContentLength > ResponseLimit {
		return nil, errors.New("speech recognition response is too large")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, ResponseLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > ResponseLimit {
		return nil, errors.New("speech recognition response is too large")
	}
	return data, nil
}

// Models lists the models the service offers. Self-hosted services list the
// models they have installed; a Kikoto Helper without one is
// kikotohelper.ErrNotInstalled.
func (c Client) Models(ctx context.Context) ([]Model, error) {
	if c.Provider.Preset().Kind == kikotohelper.Kind {
		return c.helperModels(ctx)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url("/models"), nil)
	if err != nil {
		return nil, err
	}
	data, err := c.do(req)
	if err != nil {
		return nil, err
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		return nil, errors.New("speech recognition model list is invalid")
	}
	result := []Model{}
	seen := map[string]bool{}
	// OpenAI lists every model it offers, but only its Whisper models return
	// the timed segments transcription needs.
	whisperOnly := c.Provider.PresetID == "openai"
	for _, item := range body.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || len(id) > 256 || seen[id] || len(result) >= 512 {
			continue
		}
		if whisperOnly && !strings.Contains(strings.ToLower(id), "whisper") {
			continue
		}
		seen[id] = true
		result = append(result, Model{ID: id})
	}
	return result, nil
}

// helperModels reads the installed models and their names from the helper's
// info probe, which answers without loading a model.
func (c Client) helperModels(ctx context.Context) ([]Model, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Provider.Endpoint(c.Host)+kikotohelper.InfoPath, nil)
	if err != nil {
		return nil, err
	}
	data, err := c.do(req)
	if err != nil {
		return nil, err
	}
	info, err := kikotohelper.DecodeInfo(data, kikotohelper.ServiceASR)
	if err != nil {
		return nil, err
	}
	result := []Model{}
	seen := map[string]bool{}
	for _, item := range info.Models {
		id := strings.TrimSpace(item.ID)
		if id == "" || len(id) > 256 || seen[id] || len(result) >= 512 {
			continue
		}
		seen[id] = true
		result = append(result, Model{ID: id, Name: strings.TrimSpace(item.Name)})
	}
	return result, nil
}

// Transcribe sends 16 kHz mono 16-bit PCM as a WAV file and returns its timed
// segments. Every compatible service accepts WAV, and the body is assembled
// around the samples without copying them.
func (c Client) Transcribe(ctx context.Context, model string, language string, pcm []byte) (Transcript, error) {
	var head bytes.Buffer
	form := multipart.NewWriter(&head)
	fields := [][2]string{{"model", model}, {"response_format", "verbose_json"}, {"timestamp_granularities[]", "segment"}}
	if language != "" {
		fields = append(fields, [2]string{"language", language})
	}
	for _, field := range fields {
		if err := form.WriteField(field[0], field[1]); err != nil {
			return Transcript{}, err
		}
	}
	part := textproto.MIMEHeader{}
	part.Set("Content-Disposition", `form-data; name="file"; filename="audio.wav"`)
	part.Set("Content-Type", "audio/wav")
	if _, err := form.CreatePart(part); err != nil {
		return Transcript{}, err
	}
	prefix := append(append([]byte(nil), head.Bytes()...), wavHeader(len(pcm))...)
	head.Reset()
	if err := form.Close(); err != nil {
		return Transcript{}, err
	}
	suffix := append([]byte(nil), head.Bytes()...)
	body := func() io.ReadCloser {
		return io.NopCloser(io.MultiReader(bytes.NewReader(prefix), bytes.NewReader(pcm), bytes.NewReader(suffix)))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url("/audio/transcriptions"), body())
	if err != nil {
		return Transcript{}, err
	}
	req.ContentLength = int64(len(prefix) + len(pcm) + len(suffix))
	req.GetBody = func() (io.ReadCloser, error) { return body(), nil }
	req.Header.Set("Content-Type", form.FormDataContentType())
	data, err := c.do(req)
	if err != nil {
		return Transcript{}, err
	}
	var decoded struct {
		Text     string    `json:"text"`
		Language string    `json:"language"`
		Segments []Segment `json:"segments"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return Transcript{}, errors.New("speech recognition response is invalid")
	}
	if len(decoded.Segments) == 0 && strings.TrimSpace(decoded.Text) != "" {
		return Transcript{}, ErrNoTimestamps
	}
	return Transcript{Language: decoded.Language, Segments: decoded.Segments}, nil
}

// SampleRate is the rate of the PCM the client sends; speech models resample
// to it anyway.
const SampleRate = 16000

// BytesPerSecond is the size of one second of 16 kHz mono 16-bit PCM.
const BytesPerSecond = SampleRate * 2

func wavHeader(dataBytes int) []byte {
	header := make([]byte, 44)
	copy(header[0:], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+dataBytes))
	copy(header[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1) // PCM
	binary.LittleEndian.PutUint16(header[22:], 1) // mono
	binary.LittleEndian.PutUint32(header[24:], SampleRate)
	binary.LittleEndian.PutUint32(header[28:], BytesPerSecond)
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(dataBytes))
	return header
}

// RequestLanguage maps a lyrics language token to the ISO 639-1 hint the
// protocol accepts. The empty token lets the service detect the language.
func RequestLanguage(token string) string {
	switch token {
	case "ja-jp":
		return "ja"
	case "en-us":
		return "en"
	case "zh-cn", "zh-tw":
		return "zh"
	case "ko-kr":
		return "ko"
	default:
		return ""
	}
}

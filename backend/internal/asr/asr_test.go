package asr

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestNormalizeDerivesTheSameMachineHostAndKeepsOtherOrigins(t *testing.T) {
	local, err := Normalize(Provider{PresetID: "local", BaseURL: "http://127.0.0.1:9000", Port: 8000})
	if err != nil {
		t.Fatal(err)
	}
	// A same-machine deployment never keeps an address from the request: a
	// container's loopback is not the host.
	if local.Scope != ScopeLocalMachine || local.BaseURL != "" || local.Boundary != "private" {
		t.Fatalf("local = %+v", local)
	}
	if got := local.Endpoint("gateway.example.invalid"); got != "http://gateway.example.invalid:8000" {
		t.Fatalf("endpoint = %q", got)
	}
	if _, err := Normalize(Provider{PresetID: "local"}); err == nil {
		t.Fatal("a same-machine deployment without a port was accepted")
	}

	other, err := Normalize(Provider{PresetID: "local", Scope: ScopeOtherMachine, BaseURL: "http://192.0.2.10:8000/", Port: 8000})
	if err != nil {
		t.Fatal(err)
	}
	if other.BaseURL != "http://192.0.2.10:8000" || other.Port != 0 || other.Endpoint("ignored") != "http://192.0.2.10:8000" {
		t.Fatalf("other = %+v", other)
	}
	if _, err := Normalize(Provider{PresetID: "local", Scope: ScopeOtherMachine}); err == nil {
		t.Fatal("another machine without an origin was accepted")
	}

	hosted, err := Normalize(Provider{PresetID: "openai"})
	if err != nil {
		t.Fatal(err)
	}
	if hosted.BaseURL != hosted.Preset().DefaultURL || hosted.BaseURL == "" || hosted.Scope != "" || hosted.MaxContentClass != "safe" {
		t.Fatalf("hosted = %+v", hosted)
	}
	for _, rejected := range []string{(&url.URL{Scheme: "https", Host: "example.invalid", User: url.User("synthetic")}).String(), "https://example.invalid/v1", "https://example.invalid?x=1", "ftp://example.invalid"} {
		if _, err := Normalize(Provider{PresetID: "custom-openai", BaseURL: rejected}); err == nil {
			t.Fatalf("%q was accepted", rejected)
		}
	}
}

func TestChunkCuesPlaceSegmentsOnTheTrackTimeline(t *testing.T) {
	cues := ChunkCues([]Segment{
		{Start: 0.5, End: 1.25, Text: "  first\nline  "},
		{Start: 2, End: 2, Text: "zero length"},
		{Start: 3, End: 99, Text: "past the --> end"},
		{Start: 4, End: 5, Text: "   "},
		{Start: 10, End: 11, Text: "after the chunk"},
	}, 60_000, 4_000)
	want := []Cue{
		{StartMS: 60_500, EndMS: 61_250, Text: "first line"},
		{StartMS: 62_000, EndMS: 63_000, Text: "zero length"},
		{StartMS: 63_000, EndMS: 64_000, Text: "past the -> end"},
	}
	if len(cues) != len(want) {
		t.Fatalf("cues = %+v", cues)
	}
	for index := range want {
		if cues[index] != want[index] {
			t.Fatalf("cue %d = %+v, want %+v", index, cues[index], want[index])
		}
	}
	vtt := RenderVTT(cues)
	if !strings.HasPrefix(vtt, "WEBVTT\n\n00:01:00.500 --> 00:01:01.250\nfirst line\n") || strings.Count(vtt, " --> ") != 3 {
		t.Fatalf("vtt = %q", vtt)
	}
	if got := vttTime(3_723_004); got != "01:02:03.004" {
		t.Fatalf("time = %q", got)
	}
}

func TestQuietCutFallsInTheQuietestStretch(t *testing.T) {
	const seconds = 10
	pcm := make([]byte, seconds*BytesPerSecond)
	for sample := 0; sample < len(pcm)/2; sample++ {
		value := int16(8000)
		if sample%2 == 1 {
			value = -8000
		}
		// A quiet half second from 7.0 s to 7.5 s.
		if sample >= 7*SampleRate && sample < 7*SampleRate+SampleRate/2 {
			value = 0
		}
		binary.LittleEndian.PutUint16(pcm[sample*2:], uint16(value))
	}
	cut := QuietCut(pcm, 5)
	seconds7, seconds75 := 7*BytesPerSecond, 7*BytesPerSecond+BytesPerSecond/2
	if cut <= seconds7 || cut >= seconds75 || cut%2 != 0 {
		t.Fatalf("cut at byte %d, want within [%d, %d)", cut, seconds7, seconds75)
	}
	if got := QuietCut(pcm[:100], 5); got != 100 {
		t.Fatalf("short chunk cut = %d", got)
	}
}

func TestRequestLanguageMapsLyricsLanguages(t *testing.T) {
	for token, want := range map[string]string{"": "", "ja-jp": "ja", "zh-tw": "zh", "zh-cn": "zh", "en-us": "en", "ko-kr": "ko", "fr-fr": ""} {
		if got := RequestLanguage(token); got != want {
			t.Fatalf("%q -> %q, want %q", token, got, want)
		}
	}
}

func TestWroteLanguageComparesBaseLanguages(t *testing.T) {
	for _, check := range []struct {
		reported, token string
		wrote           bool
	}{
		{"zh", "zh-cn", true},
		{"zh-CN", "zh-cn", true},
		{"zh", "zh-tw", true},
		{"japanese", "ja-jp", true},
		{"ja", "ja-jp", true},
		{"ja", "zh-cn", false},
		{"japanese", "zh-cn", false},
		{"en", "ja-jp", false},
		{"", "zh-cn", true},
		{"zh", "", true},
	} {
		if got := WroteLanguage(check.reported, check.token); got != check.wrote {
			t.Errorf("WroteLanguage(%q, %q) = %v", check.reported, check.token, got)
		}
	}
}

func TestOpenAIDiscoverySuggestsOnlyWhisperModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"example-chat"},{"id":"whisper-1"},{"id":"example-transcribe"}]}`))
	}))
	defer upstream.Close()
	for preset, want := range map[string]int{"openai": 1, "custom-openai": 3} {
		client := Client{HTTP: upstream.Client(), Provider: Provider{PresetID: preset, BaseURL: upstream.URL}}
		models, err := client.Models(context.Background())
		if err != nil || len(models) != want {
			t.Fatalf("%s models = %+v, %v", preset, models, err)
		}
	}
}

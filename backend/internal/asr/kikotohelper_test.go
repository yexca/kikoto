package asr

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
)

func TestKikotoHelperDerivesTheSameMachinePort(t *testing.T) {
	local, err := Normalize(Provider{PresetID: kikotohelper.Kind, Port: kikotohelper.ASRPort, BaseURL: "http://127.0.0.1:9000"})
	if err != nil {
		t.Fatal(err)
	}
	if local.Scope != ScopeLocalMachine || local.BaseURL != "" || local.Boundary != "private" {
		t.Fatalf("local = %+v", local)
	}
	if got := local.Endpoint("gateway.example.invalid"); got != "http://gateway.example.invalid:17656" {
		t.Fatalf("endpoint = %q", got)
	}
	if _, err := Normalize(Provider{PresetID: kikotohelper.Kind}); err == nil {
		t.Fatal("a same-machine helper without a port was accepted")
	}
}

func TestKikotoHelperListsInstalledModelsFromItsInfoProbe(t *testing.T) {
	var installed atomic.Bool
	installed.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-token" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"Missing or invalid API token","type":"unauthorized","code":"unauthorized"}}`))
			return
		}
		switch r.URL.Path {
		case kikotohelper.InfoPath:
			if installed.Load() {
				_, _ = w.Write([]byte(`{"service":"asr","api_version":1,"installed":true,"state":"stopped","model":"example-asr","models":[{"id":"example-asr","name":"Example ASR","languages":"multilingual"},{"id":"example-asr","name":"Duplicate"},{"id":"example-japanese-asr","languages":"ja"},{"id":"example-listed-asr","languages":["en","xx"]},{"id":"example-unnamed-asr"},{"id":"example-translating-asr","name":"Example translating ASR","languages":"ja","translation":{"source":"ja","target":"zh-CN"}},{"id":"example-unknown-direction","translation":{"source":"ja","target":"xx"}}]}`))
			} else {
				_, _ = w.Write([]byte(`{"service":"asr","api_version":1,"installed":false,"state":"stopped","models":[]}`))
			}
		case "/v1/audio/transcriptions":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"Model could not start","type":"start_failed","code":"start_failed","reason":"out_of_memory"}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer upstream.Close()
	p, err := Normalize(Provider{PresetID: kikotohelper.Kind, Scope: ScopeOtherMachine, BaseURL: upstream.URL, APIKey: "synthetic-token"})
	if err != nil {
		t.Fatal(err)
	}
	client := Client{HTTP: upstream.Client(), Provider: p}
	models, err := client.Models(context.Background())
	if err != nil || len(models) != 6 || models[0].Name != "Example ASR" {
		t.Fatalf("models = %+v, %v", models, err)
	}
	// Every helper model is declared: a model without a direction transcribes
	// the languages it names, any language when it names none, and a
	// translating model names its direction in lyrics language tokens.
	p.Models = models
	for _, check := range []struct {
		model, capability string
		multilingual      bool
		languages         string
	}{
		{"example-asr", CapabilityTranscribe, true, ""},
		{"example-japanese-asr", CapabilityTranscribe, false, "ja-jp"},
		{"example-listed-asr", CapabilityTranscribe, false, "en-us"},
		{"example-unnamed-asr", CapabilityTranscribe, true, ""},
		{"example-translating-asr", CapabilityTranslate, false, "ja-jp"},
		{"example-entered-by-hand", CapabilityUnknown, false, ""},
	} {
		model := p.ModelInfo(check.model)
		if model.Capability() != check.capability || model.Multilingual != check.multilingual || strings.Join(model.Languages, ",") != check.languages {
			t.Errorf("%s = %+v", check.model, model)
		}
	}
	// A direction the server cannot name matches no request. A model of
	// unknown capability writes any language from a chosen audio language,
	// and fallback lyrics only from detected speech.
	for _, check := range []struct {
		model, audio, lyrics string
		writes               bool
	}{
		{"example-asr", "ja-jp", "ja-jp", true},
		{"example-asr", "ja-jp", "zh-cn", false},
		{"example-asr", "", "", true},
		{"example-japanese-asr", "ja-jp", "ja-jp", true},
		{"example-japanese-asr", "en-us", "en-us", false},
		{"example-japanese-asr", "", "", true},
		{"example-translating-asr", "ja-jp", "zh-cn", true},
		{"example-translating-asr", "ja-jp", "ja-jp", false},
		{"example-translating-asr", "ja-jp", "zh-tw", false},
		{"example-translating-asr", "", "zh-cn", false},
		{"example-translating-asr", "", "", false},
		{"example-unknown-direction", "ja-jp", "", false},
		{"example-unknown-direction", "ja-jp", "ja-jp", false},
		{"example-entered-by-hand", "ja-jp", "ja-jp", true},
		{"example-entered-by-hand", "ja-jp", "zh-cn", true},
		{"example-entered-by-hand", "", "", true},
		{"example-entered-by-hand", "", "zh-cn", false},
		{"example-entered-by-hand", "ja-jp", "", false},
	} {
		if got := p.Writes(check.model, check.audio, check.lyrics); got != check.writes {
			t.Errorf("Writes(%s, %q, %q) = %v", check.model, check.audio, check.lyrics, got)
		}
	}

	_, err = client.Transcribe(context.Background(), "example-asr", "ja", "", make([]byte, BytesPerSecond))
	var rejected UpstreamError
	if !errors.As(err, &rejected) || rejected.Status != http.StatusServiceUnavailable || kikotohelper.Failure(rejected.Rejection) != kikotohelper.FailureOutOfMemory {
		t.Fatalf("transcription error = %#v", err)
	}

	installed.Store(false)
	if _, err := client.Models(context.Background()); !errors.Is(err, kikotohelper.ErrNotInstalled) {
		t.Fatalf("uninstalled helper error = %v", err)
	}
	client.Provider.APIKey = ""
	if _, err := client.Models(context.Background()); !errors.As(err, &rejected) || rejected.Status != http.StatusUnauthorized {
		t.Fatalf("missing token error = %v", err)
	}
}

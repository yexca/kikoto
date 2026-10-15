package asr

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
				_, _ = w.Write([]byte(`{"service":"asr","api_version":1,"installed":true,"state":"stopped","model":"example-asr","models":[{"id":"example-asr","name":"Example ASR"},{"id":"example-asr","name":"Duplicate"}]}`))
			} else {
				_, _ = w.Write([]byte(`{"service":"asr","api_version":1,"installed":false,"state":"stopped","models":[]}`))
			}
		case "/v1/audio/transcriptions":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"Runtime is not installed","type":"not_installed","code":"not_installed"}}`))
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
	if err != nil || len(models) != 1 || models[0] != (Model{ID: "example-asr", Name: "Example ASR"}) {
		t.Fatalf("models = %+v, %v", models, err)
	}

	_, err = client.Transcribe(context.Background(), "example-asr", "ja", make([]byte, BytesPerSecond))
	var rejected UpstreamError
	if !errors.As(err, &rejected) || rejected.Status != http.StatusServiceUnavailable || !kikotohelper.NotReady(rejected.Code) {
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

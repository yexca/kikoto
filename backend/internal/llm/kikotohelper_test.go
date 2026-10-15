package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
)

func TestKikotoHelperLocationAndConnection(t *testing.T) {
	local, err := Normalize(Provider{PresetID: kikotohelper.Kind, Port: kikotohelper.LLMPort, BaseURL: "http://127.0.0.1:9000"})
	if err != nil {
		t.Fatal(err)
	}
	if local.Scope != ScopeLocalMachine || local.BaseURL != "" || local.Boundary != "private" || local.OllamaScope != "" {
		t.Fatalf("local = %+v", local)
	}
	if got := local.Endpoint("gateway.example.invalid"); got != "http://gateway.example.invalid:17657" {
		t.Fatalf("endpoint = %q", got)
	}
	if _, err := Normalize(Provider{PresetID: kikotohelper.Kind}); err == nil {
		t.Fatal("a same-machine helper without a port was accepted")
	}
	if _, err := Normalize(Provider{PresetID: kikotohelper.Kind, Scope: ScopeOtherMachine}); err == nil {
		t.Fatal("another machine without an origin was accepted")
	}
	other, err := Normalize(Provider{PresetID: kikotohelper.Kind, Scope: ScopeOtherMachine, BaseURL: "http://192.0.2.10:17657/", Port: 17657})
	if err != nil || other.BaseURL != "http://192.0.2.10:17657" || other.Port != 0 {
		t.Fatalf("other = %+v, %v", other, err)
	}
	moved := local
	moved.Port = 17000
	if local.SameConnection(moved) || !local.SameConnection(local) {
		t.Fatal("a changed port must be a different connection")
	}
	// Ollama keeps its own fixed-port location.
	ollama, err := Normalize(Provider{PresetID: "ollama", Scope: ScopeOtherMachine, Port: 17657})
	if err != nil || ollama.Scope != "" || ollama.Port != 0 || ollama.Endpoint("gateway.example.invalid") != "http://gateway.example.invalid:11434" {
		t.Fatalf("ollama = %+v, %v", ollama, err)
	}
}

func TestKikotoHelperTranslatesThroughTheTaskEndpoint(t *testing.T) {
	var sent map[string]json.RawMessage
	reply := `{"text":{"title":"Example translation","lyrics":["one","two"]},"model":"example-helper-model","requests":2,"elapsed_ms":10}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("missing bearer token")
		}
		switch r.URL.Path {
		case kikotohelper.InfoPath:
			_, _ = w.Write([]byte(`{"service":"llm","api_version":1,"installed":true,"state":"stopped","model":"example-helper-model","model_name":"Example Helper Model","pairs":[["ja","zh-CN"]]}`))
		case kikotohelper.TranslatePath:
			sent = nil
			if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
				t.Error(err)
			}
			if reply == "" {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"error":{"message":"unsupported","type":"unsupported_language_pair","code":"unsupported_language_pair"}}`))
				return
			}
			_, _ = w.Write([]byte(reply))
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
	if err != nil || len(models) != 1 || models[0] != (Model{ID: "example-helper-model", Name: "Example Helper Model"}) {
		t.Fatalf("models = %+v, %v", models, err)
	}

	input := Text{Title: "Example original", Lyrics: []string{"first", "second"}}
	result, err := client.Translate(context.Background(), "example-helper-model", "ja-jp", "zh-cn", input)
	if err != nil || result.Title != "Example translation" || len(result.Lyrics) != 2 {
		t.Fatalf("result = %+v, %v", result, err)
	}
	var text map[string]json.RawMessage
	if string(sent["source"]) != `"ja-jp"` || string(sent["target"]) != `"zh-cn"` || sent["model"] != nil || json.Unmarshal(sent["text"], &text) != nil || len(text) != 2 {
		t.Fatalf("request = %s", sent)
	}
	if _, err := client.Translate(context.Background(), "example-helper-model", "", "zh-cn", input); err != nil || sent["source"] != nil {
		t.Fatalf("unknown source was sent: %s, %v", sent, err)
	}

	// The helper guarantees entry counts; a short answer is still refused.
	reply = `{"text":{"title":"Example translation","lyrics":["one"]}}`
	if _, err := client.Translate(context.Background(), "example-helper-model", "", "zh-cn", input); err == nil {
		t.Fatal("a dropped lyrics line was accepted")
	}
	reply = ""
	_, err = client.Translate(context.Background(), "example-helper-model", "en-us", "zh-cn", input)
	var rejected UpstreamError
	if !errors.As(err, &rejected) || rejected.Code != kikotohelper.CodeUnsupportedLanguagePair {
		t.Fatalf("rejection = %#v", err)
	}
}

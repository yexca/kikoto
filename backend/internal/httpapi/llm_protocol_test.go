package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func TestLLMNativeProtocolsThroughConfiguredPrivateOrigin(t *testing.T) {
	for _, kind := range []string{"openai", "anthropic", "ollama"} {
		t.Run(kind, func(t *testing.T) {
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if kind == "anthropic" {
					if r.Header.Get("x-api-key") != "synthetic-token" || r.Header.Get("anthropic-version") == "" {
						t.Error("missing native Anthropic headers")
					}
				} else if r.Header.Get("Authorization") != "Bearer synthetic-token" {
					t.Error("missing bearer credential")
				}
				if r.Method == "GET" {
					switch kind {
					case "ollama":
						if r.URL.Path != "/api/tags" {
							t.Errorf("path=%s", r.URL.Path)
						}
						_, _ = io.WriteString(w, `{"models":[{"name":"example-model"}]}`)
					default:
						if r.URL.Path != "/v1/models" {
							t.Errorf("path=%s", r.URL.Path)
						}
						_, _ = io.WriteString(w, `{"data":[{"id":"example-model"}]}`)
					}
					return
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["model"] != "example-model" || body["stream"] != false || body["tools"] != nil {
					t.Error("unexpected translation request")
				}
				switch kind {
				case "anthropic":
					if r.URL.Path != "/v1/messages" || body["system"] == nil {
						t.Error("wrong Anthropic protocol")
					}
					_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"{\"title\":\"Example translation\"}"}],"stop_reason":"end_turn"}`)
				case "ollama":
					format, _ := body["format"].(map[string]any)
					if r.URL.Path != "/api/chat" || format["type"] != "object" || body["options"] != nil || body["think"] != nil {
						t.Error("wrong Ollama protocol")
					}
					_, _ = io.WriteString(w, `{"message":{"content":"{\"title\":\"Example translation\"}"},"done":true}`)
				default:
					if r.URL.Path != "/v1/chat/completions" {
						t.Error("wrong OpenAI protocol")
					}
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"},"finish_reason":"stop"}]}`)
				}
			}))
			defer upstream.Close()
			f := newManualOverrideFixture(t, config.Config{})
			scope := ""
			if kind == "ollama" {
				scope = "other_machine"
			}
			p, err := llm.Normalize(llm.Provider{PresetID: kind, OllamaScope: scope, BaseURL: upstream.URL, APIKey: "synthetic-token"})
			if err != nil {
				t.Fatal(err)
			}
			client, closeClient, err := f.server.llmClient(context.Background(), p, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer closeClient()
			models, err := client.Models(context.Background())
			if err != nil || len(models) != 1 {
				t.Fatalf("models=%v err=%v", models, err)
			}
			result, err := client.Translate(context.Background(), "example-model", "", "zh-cn", llm.Text{Title: "Example original"})
			if err != nil || result.Title != "Example translation" || requests.Load() != 2 {
				t.Fatalf("translation=%+v err=%v requests=%d", result, err, requests.Load())
			}
		})
	}
}
func TestLLMOllamaConstrainsEntryCountsAndSendsTuning(t *testing.T) {
	var body struct {
		Format struct {
			Required   []string `json:"required"`
			Properties map[string]struct {
				MinItems int `json:"minItems"`
				MaxItems int `json:"maxItems"`
			} `json:"properties"`
			AdditionalProperties *bool `json:"additionalProperties"`
		} `json:"format"`
		Options map[string]any `json:"options"`
		Think   *bool          `json:"think"`
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_, _ = io.WriteString(w, `{"message":{"content":"{\"tags\":[\"one\",\"two\"],\"lyrics\":[\"a\",\"b\",\"c\"]}"},"done":true}`)
	}))
	defer upstream.Close()
	f := newManualOverrideFixture(t, config.Config{})
	p, err := llm.Normalize(llm.Provider{PresetID: "ollama", OllamaScope: "other_machine", BaseURL: upstream.URL, OllamaContextLength: 8192, OllamaDisableThinking: true})
	if err != nil {
		t.Fatal(err)
	}
	client, closeClient, err := f.server.llmClient(context.Background(), p, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer closeClient()
	if _, err := client.Translate(context.Background(), "example-model", "", "zh-cn", llm.Text{Tags: []string{"x", "y"}, Lyrics: []string{"l1", "l2", "l3"}}); err != nil {
		t.Fatal(err)
	}
	tags, lyrics := body.Format.Properties["tags"], body.Format.Properties["lyrics"]
	if tags.MinItems != 2 || tags.MaxItems != 2 || lyrics.MinItems != 3 || lyrics.MaxItems != 3 {
		t.Fatalf("entry counts not fixed: tags=%+v lyrics=%+v", tags, lyrics)
	}
	if len(body.Format.Properties) != 2 || len(body.Format.Required) != 2 || body.Format.AdditionalProperties == nil || *body.Format.AdditionalProperties {
		t.Fatalf("schema keys not fixed: %+v", body.Format)
	}
	if body.Options["num_ctx"] != float64(8192) || body.Think == nil || *body.Think {
		t.Fatalf("tuning not sent: options=%v think=%v", body.Options, body.Think)
	}
}

func TestLLMTransportRefusesRedirectsAndBoundsResponses(t *testing.T) {
	for _, scenario := range []string{"redirect_same_origin", "redirect_other_origin", "declared_limit", "streamed_limit", "timeout", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			var targets atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targets.Add(1) }))
			defer target.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				switch scenario {
				case "redirect_same_origin":
					http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
				case "redirect_other_origin":
					http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
				case "declared_limit":
					w.Header().Set("Content-Length", "2097153")
					w.WriteHeader(200)
				case "streamed_limit":
					if flush, ok := w.(http.Flusher); ok {
						flush.Flush()
					}
					_, _ = io.WriteString(w, strings.Repeat("x", llm.ResponseLimit+1))
				case "timeout", "cancel":
					<-r.Context().Done()
				}
			}))
			defer upstream.Close()
			f := newManualOverrideFixture(t, config.Config{})
			p, _ := llm.Normalize(llm.Provider{PresetID: "custom-openai", BaseURL: upstream.URL, APIKey: "synthetic-token"})
			client, closeClient, err := f.server.llmClient(context.Background(), p, 25*time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			defer closeClient()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if scenario == "cancel" {
				cancel()
			}
			if _, err := client.Translate(ctx, "example-model", "", "zh-cn", llm.Text{Title: "Example"}); err == nil {
				t.Fatal("unsafe or unbounded response accepted")
			}
			if targets.Load() != 0 {
				t.Fatal("redirect forwarded the credential or request")
			}
		})
	}
}
func TestLLMDemoAndLeastPrivilegeBoundary(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{Mode: "demo"})
	for _, handler := range []http.HandlerFunc{f.server.listLLMTranslationModels, f.server.listLLMReviews, f.server.translateWorkWithLLM, f.server.precheckLLMWork} {
		w := httptest.NewRecorder()
		handler(w, llmTestRequest(f, "GET", "{}"))
		if w.Code != 403 {
			t.Fatalf("Demo status=%d body=%s", w.Code, w.Body.String())
		}
	}
	f = newManualOverrideFixture(t, config.Config{})
	r := llmTestRequest(f, "GET", "")
	r = r.WithContext(context.Background())
	w := httptest.NewRecorder()
	f.server.listLLMTranslationModels(w, r)
	if w.Code != 401 {
		t.Fatal("anonymous translation models exposed")
	}
}

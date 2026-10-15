package llm

import "testing"

func TestNormalizeLocalOllamaEndpoint(t *testing.T) {
	provider, err := Normalize(Provider{PresetID: "ollama", OllamaScope: "local_machine", BaseURL: "http://127.0.0.1:11434"})
	if err != nil {
		t.Fatal(err)
	}
	if provider.BaseURL != "" {
		t.Fatalf("local Ollama retained editable URL %q", provider.BaseURL)
	}
	if got := provider.Endpoint("gateway.example.invalid"); got != "http://gateway.example.invalid:11434" {
		t.Fatalf("endpoint = %q", got)
	}
}

func TestNormalizeBoundsRequestTuning(t *testing.T) {
	provider, err := Normalize(Provider{PresetID: "ollama"})
	if err != nil || provider.RequestTimeout() != DefaultRequestTimeout {
		t.Fatalf("default timeout = %v, %v", provider.RequestTimeout(), err)
	}
	for _, invalid := range []Provider{
		{PresetID: "ollama", RequestTimeoutSeconds: MinRequestTimeoutSeconds - 1},
		{PresetID: "openai", RequestTimeoutSeconds: MaxRequestTimeoutSeconds + 1},
		{PresetID: "ollama", OllamaContextLength: MinOllamaContextLength - 1},
		{PresetID: "ollama", OllamaContextLength: MaxOllamaContextLength + 1},
	} {
		if _, err := Normalize(invalid); err == nil {
			t.Fatalf("accepted %+v", invalid)
		}
	}
	// Ollama options do not apply to another protocol.
	provider, err = Normalize(Provider{PresetID: "openai", OllamaContextLength: 8192, OllamaDisableThinking: true})
	if err != nil || provider.OllamaContextLength != 0 || provider.OllamaDisableThinking {
		t.Fatalf("provider = %+v, %v", provider, err)
	}
}

func TestNormalizeKeepsTheDefaultAmongEnabledModels(t *testing.T) {
	provider, err := Normalize(Provider{PresetID: "openai", EnabledModels: []string{" first ", "second", "first", ""}, DefaultModel: "second"})
	if err != nil || len(provider.EnabledModels) != 2 || provider.EnabledModels[0] != "first" || provider.DefaultModel != "second" {
		t.Fatalf("provider = %+v, %v", provider, err)
	}
	provider, err = Normalize(Provider{PresetID: "openai", EnabledModels: []string{"first"}, DefaultModel: "removed"})
	if err != nil || provider.DefaultModel != "first" {
		t.Fatalf("default = %q, %v", provider.DefaultModel, err)
	}
	if model, ok := provider.ResolveModel(""); !ok || model != "first" {
		t.Fatalf("resolved default = %q, %v", model, ok)
	}
	if _, ok := provider.ResolveModel("removed"); ok {
		t.Fatal("resolved a model that is not enabled")
	}
	provider, err = Normalize(Provider{PresetID: "openai", DefaultModel: "unlisted"})
	if err != nil || provider.DefaultModel != "" {
		t.Fatalf("default without enabled models = %q, %v", provider.DefaultModel, err)
	}
	tooMany := make([]string, MaxEnabledModels+1)
	for i := range tooMany {
		tooMany[i] = "model-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	for _, invalid := range [][]string{tooMany, {"bad\nmodel"}} {
		if _, err := Normalize(Provider{PresetID: "openai", EnabledModels: invalid}); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
}

func TestNormalizeRejectsEndpointPath(t *testing.T) {
	if _, err := Normalize(Provider{PresetID: "openai", BaseURL: "https://example.invalid/v1"}); err == nil {
		t.Fatal("endpoint path was accepted")
	}
}

func TestPolicyUsesAgeAndConfiguredRules(t *testing.T) {
	policy := Policy{Keywords: []KeywordRule{{Term: "secret phrase", Fields: []string{"description"}, Action: "sensitive"}}}
	if got := policy.Assess("general", map[string]string{"description": "secret phrase"}, nil); got.Class != "safe" {
		t.Fatalf("all-ages default class = %q", got.Class)
	}
	if got := (Policy{AlwaysScanAllAges: true, Keywords: policy.Keywords}).Assess("general", map[string]string{"description": "secret phrase"}, nil); got.Class != "sensitive" {
		t.Fatalf("scanned class = %q", got.Class)
	}
	if got := policy.Assess("adult", map[string]string{"description": "secret phrase"}, nil); got.Class != "sensitive" {
		t.Fatalf("adult class = %q", got.Class)
	}
}

func TestDecodeModelsSupportsOpenAIAnthropicAndOllama(t *testing.T) {
	openAI, err := DecodeModels("openai", []byte(`{"data":[{"id":"model-a"}]}`))
	if err != nil || len(openAI) != 1 || openAI[0].ID != "model-a" {
		t.Fatalf("openai = %#v, %v", openAI, err)
	}
	anthropic, err := DecodeModels("anthropic", []byte(`{"data":[{"id":"claude-a","display_name":"Claude A"}]}`))
	if err != nil || anthropic[0].Name != "Claude A" {
		t.Fatalf("anthropic = %#v, %v", anthropic, err)
	}
	ollama, err := DecodeModels("ollama", []byte(`{"models":[{"name":"qwen:latest"}]}`))
	if err != nil || ollama[0].ID != "qwen:latest" {
		t.Fatalf("ollama = %#v, %v", ollama, err)
	}
}

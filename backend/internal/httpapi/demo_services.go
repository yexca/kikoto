package httpapi

import (
	"net/http"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/llm"
)

// Demo contacts no LLM or speech recognition service. Its LLM & ASR tab lists
// these fixed samples over the real presets so every configuration option can
// be inspected; each name, origin, and model is an obvious example, and every
// change is refused. demoServiceHost stands in for the server's host gateway,
// so Demo never shows the deployment's own address.
const demoServiceHost = "host-gateway.invalid"

type demoASRService struct {
	provider asr.Provider
	hasKey   bool
}

var demoASRServices = []demoASRService{
	{provider: asr.Provider{
		ID: "demo-asr", PresetID: "custom-openai", Name: "Example speech service",
		BaseURL: "https://asr.example.invalid", Boundary: "private", MaxContentClass: "sensitive", Enabled: true,
		EnabledModels: []string{"example-small", "example-large"}, DefaultModel: "example-small",
		Models: []asr.Model{{ID: "example-small"}, {ID: "example-large"}, {ID: "example-enormous"}},
	}},
	{provider: asr.Provider{
		ID: "demo-asr-helper", PresetID: kikotohelper.Kind, Name: "Pretend helper on this machine",
		Boundary: "private", MaxContentClass: "safe", Scope: asr.ScopeLocalMachine, Port: kikotohelper.ASRPort,
		EnabledModels: []string{"example-whisper-tiny"}, DefaultModel: "example-whisper-tiny",
		Models: []asr.Model{{ID: "example-whisper-tiny", Name: "Example Whisper (tiny)"}},
	}, hasKey: true},
	{provider: asr.Provider{
		ID: "demo-asr-gpu", PresetID: "local", Name: "Imaginary GPU box",
		BaseURL: "http://gpu-box.example.invalid:8000", Boundary: "private", MaxContentClass: "safe",
		Scope: asr.ScopeOtherMachine, EnabledModels: []string{}, Models: []asr.Model{},
	}},
}

type demoLLMProvider struct {
	provider llm.Provider
	hasKey   bool
}

var demoLLMProviders = []demoLLMProvider{
	{provider: llm.Provider{
		ID: "demo-llm", PresetID: "custom-openai", Name: "Example LLM provider",
		BaseURL: "https://llm.example.invalid", Boundary: "private", MaxContentClass: "sensitive", Enabled: true,
		EnabledModels: []string{"example-model"}, DefaultModel: "example-model",
		Models: []llm.Model{{ID: "example-model"}, {ID: "example-model-mini"}},
	}, hasKey: true},
	{provider: llm.Provider{
		ID: "demo-llm-ollama", PresetID: "ollama", Name: "Make-believe Ollama",
		BaseURL: "http://ollama.example.invalid:11434", Boundary: "private", MaxContentClass: "restricted",
		OllamaScope: llm.ScopeOtherMachine, Enabled: true,
		EnabledModels: []string{"example-llama:8b", "example-qwen:14b"}, DefaultModel: "example-llama:8b",
		Models:                []llm.Model{{ID: "example-llama:8b"}, {ID: "example-qwen:14b"}, {ID: "example-gemma:2b"}},
		RequestTimeoutSeconds: 20 * 60, OllamaContextLength: 8192, OllamaDisableThinking: true,
	}},
	{provider: llm.Provider{
		ID: "demo-llm-helper", PresetID: kikotohelper.Kind, Name: "Pretend helper on this machine",
		Boundary: "private", MaxContentClass: "safe", Scope: llm.ScopeLocalMachine, Port: kikotohelper.LLMPort,
		EnabledModels: []string{"example-translator"}, DefaultModel: "example-translator",
		Models: []llm.Model{{ID: "example-translator", Pairs: []llm.LanguagePair{{Source: "ja", Target: "zh-cn"}, {Source: "ja", Target: "en"}}}},
	}, hasKey: true},
	{provider: llm.Provider{
		ID: "demo-llm-anthropic", PresetID: "custom-anthropic", Name: "Totally real cloud model",
		BaseURL: "https://anthropic-compatible.example.invalid", Boundary: "external", MaxContentClass: "safe",
		EnabledModels: []string{"example-large"}, DefaultModel: "example-large",
		Models: []llm.Model{{ID: "example-large"}},
	}, hasKey: true},
}

func writeDemoASRServices(w http.ResponseWriter) {
	result := []asrProviderResponse{}
	for _, service := range demoASRServices {
		response := asrProviderView(service.provider, demoServiceHost)
		response.HasAPIKey = service.hasKey
		result = append(result, response)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": result, "presets": asr.Presets, "hostAddress": demoServiceHost})
}

func writeDemoLLMProviders(w http.ResponseWriter) {
	result := []llmProviderResponse{}
	for _, provider := range demoLLMProviders {
		response := llmProviderView(provider.provider, demoServiceHost)
		response.HasAPIKey = provider.hasKey
		result = append(result, response)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": result, "presets": llm.Presets, "policy": llm.DefaultPolicy(), "noticeAccepted": true, "hostAddress": demoServiceHost})
}

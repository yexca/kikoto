// Package llm owns translation endpoints and deterministic content assessments.
package llm

import (
	"errors"
	"net"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

const SettingKey = "llm_providers"
const PolicyKey = "llm_content_policy"

// A translation request answers only once generation finishes, so the bound
// must fit a slow private model. Zero in a stored provider means the default.
const (
	DefaultRequestTimeout    = 10 * time.Minute
	MinRequestTimeoutSeconds = 30
	MaxRequestTimeoutSeconds = 3600
	MinOllamaContextLength   = 512
	MaxOllamaContextLength   = 1 << 20
)

type Preset struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	DefaultURL string `json:"defaultUrl"`
	ModelPath  string `json:"modelPath"`
	Prefix     string `json:"-"`
	Boundary   string `json:"boundary"`
}

var Presets = []Preset{
	{ID: "openai", Name: "OpenAI", Kind: "openai", DefaultURL: "https://api.openai.com", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
	{ID: "anthropic", Name: "Anthropic", Kind: "anthropic", DefaultURL: "https://api.anthropic.com", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
	{ID: "google", Name: "Google Gemini", Kind: "openai", DefaultURL: "https://generativelanguage.googleapis.com", Prefix: "/v1beta/openai", ModelPath: "/v1beta/openai/models", Boundary: "external"},
	{ID: "deepseek", Name: "DeepSeek", Kind: "openai", DefaultURL: "https://api.deepseek.com", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
	{ID: "openrouter", Name: "OpenRouter", Kind: "openai", DefaultURL: "https://openrouter.ai", Prefix: "/api/v1", ModelPath: "/api/v1/models", Boundary: "external"},
	{ID: "mistral", Name: "Mistral", Kind: "openai", DefaultURL: "https://api.mistral.ai", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
	{ID: "groq", Name: "Groq", Kind: "openai", DefaultURL: "https://api.groq.com", Prefix: "/openai/v1", ModelPath: "/openai/v1/models", Boundary: "external"},
	{ID: "ollama", Name: "Ollama", Kind: "ollama", Prefix: "/api", ModelPath: "/api/tags", Boundary: "private"},
	{ID: "custom-openai", Name: "Custom OpenAI-compatible", Kind: "openai", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
	{ID: "custom-anthropic", Name: "Custom Anthropic-compatible", Kind: "anthropic", Prefix: "/v1", ModelPath: "/v1/models", Boundary: "external"},
}

type Model struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type Provider struct {
	ID              string `json:"id"`
	Revision        int64  `json:"revision"`
	PresetID        string `json:"presetId"`
	Name            string `json:"name"`
	BaseURL         string `json:"baseUrl"`
	APIKey          string `json:"apiKey,omitempty"`
	Boundary        string `json:"boundary"`
	AllowSensitive  bool   `json:"allowSensitive,omitempty"` // Legacy receive scope.
	MaxContentClass string `json:"maxContentClass"`
	OllamaScope     string `json:"ollamaScope,omitempty"`
	Enabled         bool   `json:"enabled"`
	// EnabledModels are the model IDs offered for translation, in display
	// order. DefaultModel is one of them, or empty when none is enabled.
	EnabledModels []string `json:"enabledModels"`
	DefaultModel  string   `json:"defaultModel"`
	// Models are the discovered model IDs, offered as suggestions.
	Models []Model `json:"models"`
	// RequestTimeoutSeconds bounds one translation request; zero uses
	// DefaultRequestTimeout.
	RequestTimeoutSeconds int `json:"requestTimeoutSeconds,omitempty"`
	// OllamaContextLength sets Ollama's num_ctx; zero keeps the model default.
	OllamaContextLength int `json:"ollamaContextLength,omitempty"`
	// OllamaDisableThinking sends think:false; otherwise the model decides.
	OllamaDisableThinking bool `json:"ollamaDisableThinking,omitempty"`
}

// RequestTimeout is the bound of one translation request to this provider.
func (p Provider) RequestTimeout() time.Duration {
	if p.RequestTimeoutSeconds <= 0 {
		return DefaultRequestTimeout
	}
	return time.Duration(p.RequestTimeoutSeconds) * time.Second
}

// MaxEnabledModels bounds the models one provider offers.
const MaxEnabledModels = 32

// ResolveModel returns the requested model when it is enabled, or the
// default model when none is requested.
func (p Provider) ResolveModel(requested string) (string, bool) {
	if requested == "" {
		return p.DefaultModel, p.DefaultModel != ""
	}
	return requested, slices.Contains(p.EnabledModels, requested)
}

// normalizeModels trims and deduplicates the enabled models and keeps the
// default among them, falling back to the first.
func normalizeModels(enabled []string, defaultModel string) ([]string, string, error) {
	result := []string{}
	for _, id := range enabled {
		id = strings.TrimSpace(id)
		if id == "" || slices.Contains(result, id) {
			continue
		}
		if len(id) > 256 || strings.ContainsFunc(id, unicode.IsControl) {
			return nil, "", errors.New("invalid model id")
		}
		result = append(result, id)
	}
	if len(result) > MaxEnabledModels {
		return nil, "", errors.New("too many enabled models")
	}
	defaultModel = strings.TrimSpace(defaultModel)
	if !slices.Contains(result, defaultModel) {
		defaultModel = ""
		if len(result) > 0 {
			defaultModel = result[0]
		}
	}
	return result, defaultModel, nil
}

func (p Provider) Preset() Preset {
	for _, preset := range Presets {
		if preset.ID == p.PresetID {
			return preset
		}
	}
	return Preset{}
}

func (p Provider) Endpoint(host string) string {
	if p.Preset().Kind == "ollama" && p.OllamaScope == "local_machine" {
		return (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, "11434")}).String()
	}
	return p.BaseURL
}

func Normalize(p Provider) (Provider, error) {
	preset := p.Preset()
	if preset.ID == "" {
		return p, errors.New("invalid LLM provider preset")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = preset.Name
	}
	if len(p.Name) > 128 {
		return p, errors.New("LLM name is too long")
	}
	if p.Boundary == "" {
		p.Boundary = preset.Boundary
	}
	if p.Boundary != "external" && p.Boundary != "private" {
		return p, errors.New("invalid LLM data boundary")
	}
	maximum, err := contentpolicy.NormalizeMaxClass(p.MaxContentClass, p.Boundary, p.AllowSensitive)
	if err != nil {
		return p, err
	}
	p.MaxContentClass = maximum
	p.AllowSensitive = p.Boundary == "private" && maximum != "safe"

	if preset.Kind == "ollama" {
		if p.OllamaScope == "" {
			p.OllamaScope = "local_machine"
		}
		if p.OllamaScope != "local_machine" && p.OllamaScope != "other_machine" {
			return p, errors.New("invalid Ollama location")
		}
		if p.OllamaScope == "local_machine" {
			p.BaseURL = ""
		}
		if p.OllamaContextLength != 0 && (p.OllamaContextLength < MinOllamaContextLength || p.OllamaContextLength > MaxOllamaContextLength) {
			return p, errors.New("invalid Ollama context length")
		}
	} else {
		p.OllamaScope = ""
		p.OllamaContextLength = 0
		p.OllamaDisableThinking = false
	}
	if p.RequestTimeoutSeconds != 0 && (p.RequestTimeoutSeconds < MinRequestTimeoutSeconds || p.RequestTimeoutSeconds > MaxRequestTimeoutSeconds) {
		return p, errors.New("invalid LLM request timeout")
	}
	p.APIKey = strings.TrimSpace(p.APIKey)
	if len(p.APIKey) > 4096 || strings.ContainsFunc(p.APIKey, unicode.IsControl) {
		return p, errors.New("invalid API key")
	}
	p.EnabledModels, p.DefaultModel, err = normalizeModels(p.EnabledModels, p.DefaultModel)
	if err != nil {
		return p, err
	}
	if p.Models == nil {
		p.Models = []Model{}
	}
	if preset.Kind == "ollama" && p.OllamaScope == "local_machine" {
		return p, nil
	}
	base := strings.TrimSpace(p.BaseURL)
	if base == "" {
		base = preset.DefaultURL
	}
	if !strings.Contains(base, "://") {
		base = "https://" + base
	}
	parsed, err := outbound.ParseHTTPURL(base)
	if err != nil || parsed.RawQuery != "" || parsed.ForceQuery || (parsed.Path != "" && parsed.Path != "/") {
		return p, errors.New("enter an HTTP(S) origin without credentials, query or API path")
	}
	parsed.Path = ""
	parsed.Host = strings.ToLower(parsed.Host)
	p.BaseURL = parsed.String()
	return p, nil
}

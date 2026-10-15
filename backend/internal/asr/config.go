// Package asr configures speech recognition services and speaks the
// OpenAI-compatible transcription protocol that hosted and self-hosted
// services share.
package asr

import (
	"errors"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

const SettingKey = "asr_providers"

// MaxProviders bounds the stored service list.
const MaxProviders = 16

// Scope values place a local deployment on the server's own machine, whose
// host the server derives, or on another machine the administrator names.
const (
	ScopeLocalMachine = "local_machine"
	ScopeOtherMachine = "other_machine"
)

type Preset struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind is the protocol: "openai", or "kikoto-helper", which transcribes
	// through the same endpoint and lists its models through an info probe.
	Kind       string `json:"kind"`
	DefaultURL string `json:"defaultUrl"`
	Boundary   string `json:"boundary"`
	// Local presets choose between this server's machine and another one.
	Local bool `json:"local"`
	// DefaultPort is the port a local preset suggests, or zero.
	DefaultPort int `json:"defaultPort,omitempty"`
	// KeyRequired presets refuse every request without a key.
	KeyRequired bool `json:"keyRequired,omitempty"`
}

var Presets = []Preset{
	{ID: "openai", Name: "OpenAI", Kind: "openai", DefaultURL: "https://api.openai.com", Boundary: "external"},
	{ID: "local", Name: "Local deployment", Kind: "openai", Boundary: "private", Local: true},
	{ID: kikotohelper.Kind, Name: "Kikoto Helper", Kind: kikotohelper.Kind, Boundary: "private", Local: true, DefaultPort: kikotohelper.ASRPort, KeyRequired: true},
	{ID: "custom-openai", Name: "Custom OpenAI-compatible", Kind: "openai", Boundary: "external"},
}

// apiPrefix is the protocol path every preset shares.
const apiPrefix = "/v1"

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
	MaxContentClass string `json:"maxContentClass"`
	Scope           string `json:"scope,omitempty"`
	Port            int    `json:"port,omitempty"`
	Enabled         bool   `json:"enabled"`
	// EnabledModels are the model IDs offered for transcription, in display
	// order. DefaultModel is one of them, or empty when none is enabled.
	EnabledModels []string `json:"enabledModels"`
	DefaultModel  string   `json:"defaultModel"`
	// Models are the discovered model IDs, offered as suggestions.
	Models []Model `json:"models"`
}

// MaxEnabledModels bounds the models one service offers.
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

// DerivesHost reports whether the server, not the administrator, chooses the
// service host: a local deployment on this server's machine.
func (p Provider) DerivesHost() bool {
	return p.Preset().Local && p.Scope == ScopeLocalMachine
}

// Endpoint is the service origin. A same-machine deployment is reached through
// the server's host gateway on the configured port, so a container never
// mistakes its own loopback address for the host.
func (p Provider) Endpoint(host string) string {
	if p.DerivesHost() {
		return (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, strconv.Itoa(p.Port))}).String()
	}
	return p.BaseURL
}

// SameConnection reports whether two configurations reach the same service.
// A key and discovered models belong to one connection only.
func (p Provider) SameConnection(other Provider) bool {
	return p.PresetID == other.PresetID && p.Scope == other.Scope && p.Port == other.Port && p.BaseURL == other.BaseURL
}

func Normalize(p Provider) (Provider, error) {
	preset := p.Preset()
	if preset.ID == "" {
		return p, errors.New("invalid speech recognition preset")
	}
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		p.Name = preset.Name
	}
	if len(p.Name) > 128 {
		return p, errors.New("speech recognition service name is too long")
	}
	if p.Boundary == "" {
		p.Boundary = preset.Boundary
	}
	if p.Boundary != "external" && p.Boundary != "private" {
		return p, errors.New("invalid speech recognition data boundary")
	}
	maximum, err := contentpolicy.NormalizeMaxClass(p.MaxContentClass)
	if err != nil {
		return p, err
	}
	p.MaxContentClass = maximum

	if preset.Local {
		if p.Scope == "" {
			p.Scope = ScopeLocalMachine
		}
		if p.Scope != ScopeLocalMachine && p.Scope != ScopeOtherMachine {
			return p, errors.New("invalid local deployment location")
		}
	} else {
		p.Scope = ""
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
	if p.DerivesHost() {
		if p.Port < 1 || p.Port > 65535 {
			return p, errors.New("enter the port of the local deployment")
		}
		// The host is derived; an address in the request body is never kept.
		p.BaseURL = ""
		return p, nil
	}
	p.Port = 0
	base := strings.TrimSpace(p.BaseURL)
	if base == "" {
		base = preset.DefaultURL
	}
	if base == "" {
		return p, errors.New("enter the service origin")
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

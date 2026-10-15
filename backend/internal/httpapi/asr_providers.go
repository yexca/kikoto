package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/proxyconfig"
)

type asrProviderResponse struct {
	ID             string      `json:"id"`
	PresetID       string      `json:"presetId"`
	Name           string      `json:"name"`
	BaseURL        string      `json:"baseUrl"`
	Boundary       string      `json:"boundary"`
	AllowSensitive bool        `json:"allowSensitive"`
	Scope          string      `json:"scope,omitempty"`
	Port           int         `json:"port,omitempty"`
	Enabled        bool        `json:"enabled"`
	HasAPIKey      bool        `json:"hasApiKey"`
	DefaultModel   string      `json:"defaultModel"`
	Models         []asr.Model `json:"models"`
}

func (s *Server) asrResponse(p asr.Provider) asrProviderResponse {
	return asrProviderResponse{ID: p.ID, PresetID: p.PresetID, Name: p.Name, BaseURL: p.Endpoint(s.cfg.HostProxyAddress()), Boundary: p.Boundary, AllowSensitive: p.AllowSensitive, Scope: p.Scope, Port: p.Port, Enabled: p.Enabled, HasAPIKey: p.APIKey != "", DefaultModel: p.DefaultModel, Models: p.Models}
}

func writeASRDisabled(w http.ResponseWriter) {
	writeAPIError(w, 403, "asr_disabled", "Speech recognition is unavailable in Demo.", false)
}

func (s *Server) listASRProviders(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	providers, err := s.asrStore.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result := []asrProviderResponse{}
	for _, p := range providers {
		result = append(result, s.asrResponse(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": result, "presets": asr.Presets, "hostAddress": s.cfg.HostProxyAddress()})
}

type asrProviderPayload struct {
	PresetID       string  `json:"presetId"`
	Name           string  `json:"name"`
	BaseURL        *string `json:"baseUrl"`
	APIKey         *string `json:"apiKey"`
	Boundary       string  `json:"boundary"`
	AllowSensitive *bool   `json:"allowSensitive"`
	Scope          string  `json:"scope"`
	Port           *int    `json:"port"`
	Enabled        *bool   `json:"enabled"`
	DefaultModel   *string `json:"defaultModel"`
}

func (s *Server) saveASRProvider(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if !s.requireServiceNotice(w, r) {
		return
	}
	var body asrProviderPayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeAPIError(w, 400, "invalid_asr_config", "Invalid speech recognition configuration.", false)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeAPIError(w, 400, "invalid_asr_config", "Send exactly one service configuration.", false)
		return
	}
	id := r.PathValue("id")
	p := asr.Provider{PresetID: body.PresetID, Enabled: true}
	if id != "" {
		current, err := s.asrStore.Get(r.Context(), id)
		if errors.Is(err, asr.ErrNotFound) {
			writeAPIError(w, 404, "asr_not_found", "Speech recognition service not found.", false)
			return
		}
		if err != nil {
			writeError(w, err)
			return
		}
		p = current
	}
	if body.PresetID != "" {
		p.PresetID = body.PresetID
	}
	if body.Name != "" {
		p.Name = body.Name
	}
	if body.BaseURL != nil {
		p.BaseURL = *body.BaseURL
	}
	if body.Boundary != "" {
		p.Boundary = body.Boundary
	}
	if body.AllowSensitive != nil {
		p.AllowSensitive = *body.AllowSensitive
	}
	if body.Scope != "" {
		p.Scope = body.Scope
	}
	if body.Port != nil {
		p.Port = *body.Port
	}
	if body.Enabled != nil {
		p.Enabled = *body.Enabled
	}
	if body.DefaultModel != nil {
		p.DefaultModel = *body.DefaultModel
	}
	saved, err := s.asrStore.Mutate(r.Context(), id, p, body.APIKey, false)
	if errors.Is(err, asr.ErrNotFound) {
		writeAPIError(w, 404, "asr_not_found", "Speech recognition service not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, 400, "invalid_asr_config", "Check the service, location, port, endpoint and model settings.", false)
		return
	}
	writeJSON(w, http.StatusOK, s.asrResponse(saved))
}

func (s *Server) deleteASRProvider(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if _, err := s.asrStore.Mutate(r.Context(), r.PathValue("id"), asr.Provider{}, nil, true); err != nil {
		writeAPIError(w, 404, "asr_not_found", "Speech recognition service not found.", false)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) fetchASRModels(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if !s.requireServiceNotice(w, r) {
		return
	}
	p, err := s.asrStore.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeAPIError(w, 404, "asr_not_found", "Speech recognition service not found.", false)
		return
	}
	client, closeClient, err := s.asrClient(r.Context(), p, 20*time.Second)
	if err != nil {
		writeAPIError(w, 502, "asr_models_failed", "Models could not be fetched.", false)
		return
	}
	defer closeClient()
	models, err := client.Models(r.Context())
	if err != nil {
		writeAPIError(w, 502, "asr_models_failed", "Models could not be fetched. Check the endpoint and key.", false)
		return
	}
	p, err = s.asrStore.Models(r.Context(), p, models)
	if err != nil {
		writeAPIError(w, 409, "asr_config_changed", "Service settings changed. Fetch models again.", false)
		return
	}
	writeJSON(w, 200, s.asrResponse(p))
}

// listASRServices offers the enabled services with a model to library writers
// choosing where to transcribe, without connection details.
func (s *Server) listASRServices(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	providers, err := s.asrStore.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result := []map[string]any{}
	for _, p := range providers {
		if p.Enabled && p.DefaultModel != "" {
			result = append(result, map[string]any{"id": p.ID, "name": p.Name, "defaultModel": p.DefaultModel, "boundary": p.Boundary, "allowSensitive": p.AllowSensitive})
		}
	}
	writeJSON(w, 200, result)
}

// asrConfigHash identifies everything that decides where audio goes and how
// it is transcribed, so a task notices a changed service before sending more.
func (s *Server) asrConfigHash(p asr.Provider) string {
	p.Name = ""
	p.Models = nil
	p.Revision = 0
	p.BaseURL = p.Endpoint(s.cfg.HostProxyAddress())
	return llmValueHash(p)
}

// asrClient reaches only the administrator-configured origin, including its
// private address exception, and refuses every redirect. A transcription
// service answers once a chunk is transcribed, so the header wait is the
// request bound rather than the default.
func (s *Server) asrClient(ctx context.Context, p asr.Provider, timeout time.Duration) (asr.Client, func(), error) {
	base := p.Endpoint(s.cfg.HostProxyAddress())
	route, err := s.resolveProxyRoute(ctx, proxyconfig.ScopeOther, 0)
	if err != nil {
		return asr.Client{}, nil, err
	}
	transport, err := proxiedTransport(route, func(proxy *url.URL) (*outbound.Policy, error) {
		return outbound.NewPolicy([]outbound.Destination{{URL: base, AllowPrivate: true}}, outbound.Options{Proxy: proxy, ResponseHeaderTimeout: timeout})
	})
	if err != nil {
		return asr.Client{}, nil, err
	}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return asr.Client{HTTP: client, Provider: p, Host: s.cfg.HostProxyAddress()}, func() { closeIdleConnections(transport) }, nil
}

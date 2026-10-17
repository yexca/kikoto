package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/proxyconfig"
)

type llmProviderResponse struct {
	ID              string      `json:"id"`
	PresetID        string      `json:"presetId"`
	Name            string      `json:"name"`
	Kind            string      `json:"kind"`
	BaseURL         string      `json:"baseUrl"`
	Boundary        string      `json:"boundary"`
	MaxContentClass string      `json:"maxContentClass"`
	OllamaScope     string      `json:"ollamaScope,omitempty"`
	Scope           string      `json:"scope,omitempty"`
	Port            int         `json:"port,omitempty"`
	Enabled         bool        `json:"enabled"`
	HasAPIKey       bool        `json:"hasApiKey"`
	EnabledModels   []string    `json:"enabledModels"`
	DefaultModel    string      `json:"defaultModel"`
	Models          []llm.Model `json:"models"`
	// RequestTimeoutSeconds is the effective bound, including the default.
	RequestTimeoutSeconds int  `json:"requestTimeoutSeconds"`
	OllamaContextLength   int  `json:"ollamaContextLength,omitempty"`
	OllamaDisableThinking bool `json:"ollamaDisableThinking,omitempty"`
}

func (s *Server) llmResponse(p llm.Provider) llmProviderResponse {
	return llmProviderResponse{ID: p.ID, PresetID: p.PresetID, Name: p.Name, Kind: p.Preset().Kind, BaseURL: p.Endpoint(s.cfg.HostProxyAddress()), Boundary: p.Boundary, MaxContentClass: p.MaxContentClass, OllamaScope: p.OllamaScope, Scope: p.Scope, Port: p.Port, Enabled: p.Enabled, HasAPIKey: p.APIKey != "", EnabledModels: p.EnabledModels, DefaultModel: p.DefaultModel, Models: p.Models, RequestTimeoutSeconds: int(p.RequestTimeout() / time.Second), OllamaContextLength: p.OllamaContextLength, OllamaDisableThinking: p.OllamaDisableThinking}
}

func (s *Server) listLLMProviders(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	providers, err := s.llmStore.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result := []llmProviderResponse{}
	for _, p := range providers {
		result = append(result, s.llmResponse(p))
	}
	policy, err := s.llmStore.Policy(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	noticeAccepted, err := s.llmStore.NoticeAccepted(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": result, "presets": llm.Presets, "policy": policy, "noticeAccepted": noticeAccepted, "hostAddress": s.cfg.HostProxyAddress()})
}

// requireServiceNotice refuses LLM and ASR configuration until an
// administrator has accepted the external service notice. Removing a service
// and using an already configured one stay available.
func (s *Server) requireServiceNotice(w http.ResponseWriter, r *http.Request) bool {
	accepted, err := s.llmStore.NoticeAccepted(r.Context())
	if err != nil {
		writeError(w, err)
		return false
	}
	if !accepted {
		writeAPIError(w, http.StatusConflict, "service_notice_required", "Accept the external service notice before configuring LLM or ASR services.", false)
		return false
	}
	return true
}

func (s *Server) acceptServiceNotice(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	user, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	if err := s.llmStore.AcceptNotice(r.Context(), user.ID, time.Now()); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"noticeAccepted": true})
}

func (s *Server) getLLMPolicy(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	policy, err := s.llmStore.Policy(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (s *Server) updateLLMPolicy(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if !s.requireServiceNotice(w, r) {
		return
	}
	var policy llm.Policy
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_llm_policy", "Invalid policy fields or JSON. Policy requests must fit within 64 KiB.", false)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeAPIError(w, 400, "invalid_llm_policy", "Send exactly one policy object.", false)
		return
	}
	var err error
	policy, err = policy.Validate()
	if err != nil {
		writeAPIError(w, 400, "invalid_llm_policy", err.Error(), false)
		return
	}
	if len(policy.TagRules) > 0 {
		args := make([]any, len(policy.TagRules))
		for i, rule := range policy.TagRules {
			args[i] = rule.TagID
		}
		var count int
		if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM metadata_tag WHERE tag_id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(args)), ",")+")", args...).Scan(&count); err != nil {
			writeError(w, err)
			return
		}
		if count != len(policy.TagRules) {
			writeAPIError(w, 400, "invalid_llm_policy", "A selected metadata tag does not exist. Choose an existing shared tag.", false)
			return
		}
	}
	if err := s.llmStore.SavePolicy(r.Context(), policy); err != nil {
		writeError(w, err)
		return
	}
	policy, err = s.llmStore.Policy(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

type llmProviderPayload struct {
	Kind            string    `json:"kind"`
	PresetID        string    `json:"presetId"`
	Name            string    `json:"name"`
	BaseURL         *string   `json:"baseUrl"`
	APIKey          *string   `json:"apiKey"`
	Boundary        string    `json:"boundary"`
	MaxContentClass *string   `json:"maxContentClass"`
	OllamaScope     string    `json:"ollamaScope"`
	Scope           string    `json:"scope"`
	Port            *int      `json:"port"`
	Enabled         *bool     `json:"enabled"`
	EnabledModels   *[]string `json:"enabledModels"`
	DefaultModel    *string   `json:"defaultModel"`
	// Request tuning; an omitted field keeps the saved value.
	RequestTimeoutSeconds *int  `json:"requestTimeoutSeconds"`
	OllamaContextLength   *int  `json:"ollamaContextLength"`
	OllamaDisableThinking *bool `json:"ollamaDisableThinking"`
}

func (body llmProviderPayload) applyTuning(p *llm.Provider) {
	if body.RequestTimeoutSeconds != nil {
		p.RequestTimeoutSeconds = *body.RequestTimeoutSeconds
	}
	if body.OllamaContextLength != nil {
		p.OllamaContextLength = *body.OllamaContextLength
	}
	if body.OllamaDisableThinking != nil {
		p.OllamaDisableThinking = *body.OllamaDisableThinking
	}
}

func (s *Server) saveLLMProvider(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if !s.requireServiceNotice(w, r) {
		return
	}
	var body llmProviderPayload
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeAPIError(w, 400, "invalid_llm_config", "Invalid LLM configuration.", false)
		return
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeAPIError(w, 400, "invalid_llm_config", "Send exactly one provider configuration.", false)
		return
	}
	p := llm.Provider{PresetID: body.PresetID, Name: body.Name, Boundary: body.Boundary, OllamaScope: body.OllamaScope, Scope: body.Scope}
	if body.BaseURL != nil {
		p.BaseURL = *body.BaseURL
	}
	if body.Port != nil {
		p.Port = *body.Port
	}
	if id := r.PathValue("id"); id != "" {
		current, loadErr := s.llmProvider(r.Context(), id)
		if errors.Is(loadErr, llm.ErrNotFound) {
			writeAPIError(w, 404, "llm_not_found", "LLM provider not found.", false)
			return
		}
		if loadErr != nil {
			writeError(w, loadErr)
			return
		}
		p = current
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
		if body.OllamaScope != "" {
			p.OllamaScope = body.OllamaScope
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
	}
	if body.EnabledModels != nil {
		p.EnabledModels = *body.EnabledModels
	}
	if body.DefaultModel != nil {
		p.DefaultModel = *body.DefaultModel
	}
	if body.MaxContentClass != nil {
		if *body.MaxContentClass == "" {
			writeAPIError(w, 400, "invalid_llm_config", "Choose one explicit content receive maximum.", false)
			return
		}
		p.MaxContentClass = *body.MaxContentClass
	}
	body.applyTuning(&p)
	if body.Kind != "" && body.Kind != p.Preset().Kind {
		writeAPIError(w, 400, "invalid_llm_config", "The preset selects the provider protocol.", false)
		return
	}
	if body.Enabled != nil && r.PathValue("id") == "" {
		p.Enabled = *body.Enabled
	}
	saved, err := s.llmStore.Mutate(r.Context(), r.PathValue("id"), p, body.APIKey, false)
	if errors.Is(err, llm.ErrNotFound) {
		writeAPIError(w, 404, "llm_not_found", "LLM provider not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, 400, "invalid_llm_config", "Check the provider, endpoint, location, model and request settings.", false)
		return
	}
	writeJSON(w, http.StatusOK, s.llmResponse(saved))
}

func (s *Server) deleteLLMProvider(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	_, err := s.llmStore.Mutate(r.Context(), r.PathValue("id"), llm.Provider{}, nil, true)
	if err != nil {
		writeAPIError(w, 404, "llm_not_found", "LLM provider not found.", false)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) llmProvider(ctx context.Context, id string) (llm.Provider, error) {
	providers, err := s.llmStore.List(ctx)
	if err != nil {
		return llm.Provider{}, err
	}
	for _, p := range providers {
		if p.ID == id {
			return p, nil
		}
	}
	return llm.Provider{}, llm.ErrNotFound
}

func (s *Server) fetchLLMModels(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if !s.requireServiceNotice(w, r) {
		return
	}
	p, err := s.llmProvider(r.Context(), r.PathValue("id"))
	if err != nil {
		writeAPIError(w, 404, "llm_not_found", "LLM provider not found.", false)
		return
	}
	if !s.acquireLLMSlot(w, r) {
		return
	}
	defer func() { <-s.llmRequestSlots }()
	client, closeClient, err := s.llmClient(r.Context(), p, 20*time.Second)
	if err != nil {
		writeAPIError(w, 502, "llm_models_failed", "Models could not be fetched.", false)
		return
	}
	defer closeClient()
	models, err := client.Models(r.Context())
	if errors.Is(err, kikotohelper.ErrNotInstalled) {
		writeAPIError(w, 502, "service_model_not_installed", "The service has no installed model. Install one in the service first.", false)
		return
	}
	if errors.Is(err, kikotohelper.ErrAgreementRequired) {
		writeAPIError(w, 502, "service_agreement_required", "The service's model needs its risk notice accepted. Accept it on the helper's Translation page first.", false)
		return
	}
	if err != nil {
		writeAPIError(w, 502, "llm_models_failed", "Models could not be fetched. Check the endpoint and key.", false)
		return
	}
	p, err = s.llmStore.Models(r.Context(), p, models)
	if err != nil {
		writeAPIError(w, 409, "llm_config_changed", "Provider settings changed. Fetch models again.", false)
		return
	}
	writeJSON(w, 200, s.llmResponse(p))
}

func (s *Server) acquireLLMSlot(w http.ResponseWriter, r *http.Request) bool {
	select {
	case s.llmRequestSlots <- struct{}{}:
		return true
	default:
		writeAPIError(w, 429, "llm_busy", "Translation service is busy. Try again shortly.", false)
		return false
	}
}

// Only the administrator-configured origin is allowed, including its private
// address exception. Discovery and translation refuse every redirect. A
// translation answers once generation finishes, so the header wait is the
// request bound rather than the default.
func (s *Server) llmClient(ctx context.Context, p llm.Provider, timeout time.Duration) (llm.Client, func(), error) {
	base := p.Endpoint(s.cfg.HostProxyAddress())
	route, err := s.resolveProxyRoute(ctx, proxyconfig.ScopeOther, 0)
	if err != nil {
		return llm.Client{}, nil, err
	}
	transport, err := proxiedTransport(route, func(proxy *url.URL) (*outbound.Policy, error) {
		return outbound.NewPolicy([]outbound.Destination{{URL: base, AllowPrivate: true}}, outbound.Options{Proxy: proxy, ResponseHeaderTimeout: timeout})
	})
	if err != nil {
		return llm.Client{}, nil, err
	}
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return llm.Client{HTTP: client, Provider: p, Host: s.cfg.HostProxyAddress()}, func() { closeIdleConnections(transport) }, nil
}

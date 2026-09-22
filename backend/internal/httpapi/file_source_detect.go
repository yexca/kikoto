package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

const (
	fileSourceDetectTimeout      = 20 * time.Second
	fileSourceDetectProbeTimeout = 8 * time.Second
	maxFileSourceDetectInput     = 2048
)

type fileSourceDetectRequest struct {
	URL string `json:"url"`
}

type fileSourceDetectResult struct {
	Detected    bool     `json:"detected"`
	SourceType  string   `json:"sourceType"`
	DisplayName string   `json:"displayName"`
	BaseURL     string   `json:"baseUrl"`
	APIURL      string   `json:"apiUrl"`
	Tried       []string `json:"tried"`
}

// detectFileSource probes a small, bounded set of Kikoeru-compatible API bases
// derived from one administrator-entered address. Every candidate is derived
// from that trusted input, so the configured-origin exception applies, but each
// probe is still restricted to its own origin and redirects are validated by
// the shared outbound policy. Upstream error details are never returned.
func (s *Server) detectFileSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var request fileSourceDetectRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	input, err := normalizeFileSourceDetectInput(request.URL)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "address must be an HTTP(S) URL without credentials"})
		return
	}
	candidates := fileSourceDetectCandidates(input)
	result := fileSourceDetectResult{
		SourceType: sourceTypeKikoeruCompatible, DisplayName: fileSourceDetectDisplayName(input),
		BaseURL: fileSourceDetectBaseURL(input), Tried: candidates,
	}
	ctx, cancel := context.WithTimeout(r.Context(), fileSourceDetectTimeout)
	defer cancel()
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		if s.probeKikoeruAPI(ctx, candidate) {
			result.Detected = true
			result.APIURL = candidate
			break
		}
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) probeKikoeruAPI(ctx context.Context, apiURL string) bool {
	source := remoteSourceForUse{
		SourceType: sourceTypeKikoeruCompatible,
		Enabled:    true,
		Endpoint:   fileSourceEndpoint{APIURL: apiURL, RestrictOutboundHosts: true},
	}
	policy, err := sourceOutboundPolicy(source)
	if err != nil {
		return false
	}
	probeCtx, cancel := context.WithTimeout(ctx, fileSourceDetectProbeTimeout)
	defer cancel()
	client := kikoeru.NewClient(apiURL, policy.Client(nil, fileSourceDetectProbeTimeout))
	page, err := client.ListWorks(probeCtx, 1, 1, "")
	// A single-page application commonly answers every path with HTML or an
	// unrelated JSON object; only a real works payload counts as detected.
	return err == nil && page.Works != nil
}

func normalizeFileSourceDetectInput(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if len(value) > maxFileSourceDetectInput {
		return nil, errors.New("address is too long")
	}
	if value != "" && !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := outbound.ParseHTTPURL(value)
	if err != nil {
		return nil, err
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed, nil
}

// fileSourceDetectCandidates returns API bases in probe order: the address as
// entered (without a trailing /api segment), its origin, and the conventional
// api.<host> sibling. The list is deduplicated and never longer than four.
func fileSourceDetectCandidates(input *url.URL) []string {
	origin := input.Scheme + "://" + input.Host
	path := strings.TrimRight(input.EscapedPath(), "/")
	lowerPath := strings.ToLower(path)
	for _, suffix := range []string{"/api/health", "/api/works", "/api"} {
		if strings.HasSuffix(lowerPath, suffix) {
			path = path[:len(path)-len(suffix)]
			lowerPath = strings.ToLower(path)
		}
	}
	candidates := []string{}
	seen := map[string]bool{}
	add := func(value string) {
		value = strings.TrimRight(value, "/")
		if value == "" || seen[strings.ToLower(value)] || len(candidates) >= 4 {
			return
		}
		seen[strings.ToLower(value)] = true
		candidates = append(candidates, value)
	}
	add(origin + path)
	add(origin)
	host := strings.ToLower(input.Hostname())
	if !strings.HasPrefix(host, "api.") && strings.Contains(host, ".") && !isIPLiteralHost(host) {
		sibling := "api." + strings.TrimPrefix(host, "www.")
		if port := input.Port(); port != "" {
			sibling += ":" + port
		}
		add(input.Scheme + "://" + sibling)
	}
	return candidates
}

func fileSourceDetectBaseURL(input *url.URL) string {
	host := input.Host
	if lower := strings.ToLower(host); strings.HasPrefix(lower, "api.") && strings.Count(lower, ".") >= 2 {
		host = host[len("api."):]
	}
	return input.Scheme + "://" + host
}

func fileSourceDetectDisplayName(input *url.URL) string {
	host := strings.ToLower(input.Hostname())
	host = strings.TrimPrefix(strings.TrimPrefix(host, "www."), "api.")
	if host == "" {
		return "Remote source"
	}
	return host
}

func isIPLiteralHost(host string) bool {
	return net.ParseIP(strings.Trim(host, "[]")) != nil
}

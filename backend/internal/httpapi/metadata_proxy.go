package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

// metadataProxySetting stores the optional forward proxy for built-in
// metadata requests. An empty value connects directly.
const metadataProxySetting = "metadata_proxy_url"

var errMetadataProxyUnavailable = errors.New("metadata proxy setting is unavailable")

// normalizeMetadataProxyURL validates administrator input. Empty input clears
// the proxy.
func normalizeMetadataProxyURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	parsed, err := outbound.ParseProxyURL(value)
	if err != nil {
		return "", invalidSettings("metadataProxyUrl must be an http, https, socks5, or socks5h URL with a host and port and without credentials or a path")
	}
	return parsed.String(), nil
}

func (s *Server) loadMetadataProxyURL(ctx context.Context) (string, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", metadataProxySetting).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return "", errMetadataProxyUnavailable
	}
	normalized, err := normalizeMetadataProxyURL(value)
	if err != nil {
		// Fail closed rather than silently connecting directly when the
		// stored proxy cannot be used.
		return "", errMetadataProxyUnavailable
	}
	return normalized, nil
}

// metadataTransport routes built-in DLsite requests through the currently
// configured metadata proxy. The proxy is loaded on first use, replaced when
// the setting changes, and each replacement closes the previous transport's
// idle connections. URL, redirect, and address checks come from the same
// DLsite outbound policy with or without a proxy.
type metadataTransport struct {
	endpoints dlsite.Endpoints
	load      func(context.Context) (string, error)

	mu        sync.Mutex
	loaded    bool
	proxy     string
	transport http.RoundTripper
}

func newMetadataTransport(endpoints dlsite.Endpoints, load func(context.Context) (string, error)) *metadataTransport {
	return &metadataTransport{endpoints: endpoints, load: load}
}

func (t *metadataTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	transport, err := t.current(request.Context())
	if err != nil {
		if request.Body != nil {
			_ = request.Body.Close()
		}
		return nil, err
	}
	return transport.RoundTrip(request)
}

func (t *metadataTransport) current(ctx context.Context) (http.RoundTripper, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.loaded {
		value, err := t.load(ctx)
		if err != nil {
			return nil, err
		}
		t.proxy = value
		t.loaded = true
	}
	if t.transport == nil {
		var proxy *url.URL
		if t.proxy != "" {
			parsed, err := outbound.ParseProxyURL(t.proxy)
			if err != nil {
				return nil, errMetadataProxyUnavailable
			}
			proxy = parsed
		}
		policy, err := t.endpoints.Policy(proxy)
		if err != nil {
			return nil, errMetadataProxyUnavailable
		}
		t.transport = policy.Transport()
	}
	return t.transport, nil
}

// setProxy applies a committed setting change to subsequent requests.
func (t *metadataTransport) setProxy(value string) {
	t.mu.Lock()
	if t.loaded && t.proxy == value {
		t.mu.Unlock()
		return
	}
	previous := t.transport
	t.proxy = value
	t.loaded = true
	t.transport = nil
	t.mu.Unlock()
	closeIdleConnections(previous)
}

func (t *metadataTransport) CloseIdleConnections() {
	t.mu.Lock()
	transport := t.transport
	t.mu.Unlock()
	closeIdleConnections(transport)
}

func closeIdleConnections(transport http.RoundTripper) {
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

// newMetadataHTTPClient builds the shared DLsite client whose redirect checks
// use the built-in destination policy and whose transport follows the
// configured metadata proxy.
func newMetadataHTTPClient(endpoints dlsite.Endpoints, transport http.RoundTripper) *http.Client {
	policy, err := endpoints.Policy(nil)
	if err != nil {
		panic("invalid built-in metadata destination policy")
	}
	return policy.Client(transport, dlsite.RequestTimeout)
}

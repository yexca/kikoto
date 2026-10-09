package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/proxyconfig"
)

const (
	// outboundProxySetting stores the proxy list and routes as JSON.
	outboundProxySetting = "outbound_proxy_config"
	// legacyMetadataProxySetting holds the single DLsite proxy URL. It
	// is read until the proxy configuration is first saved, then removed.
	legacyMetadataProxySetting = "metadata_proxy_url"
)

// errProxyConfigUnavailable fails outbound requests closed when the stored
// proxy configuration cannot be used, rather than silently connecting
// directly.
var errProxyConfigUnavailable = errors.New("outbound proxy setting is unavailable")

type proxySettingsResponse struct {
	// HostAddress is the address a local-machine proxy resolves to. It is
	// runtime configuration and cannot be changed from the settings API.
	HostAddress    string             `json:"hostAddress"`
	Proxies        []proxyResponse    `json:"proxies"`
	Routes         proxyconfig.Routes `json:"routes"`
	DirectFallback bool               `json:"directFallback"`
}

// proxyResponse never includes the stored password.
type proxyResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Scheme      string `json:"scheme"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Username    string `json:"username"`
	HasPassword bool   `json:"hasPassword"`
}

type proxySettingsPayload struct {
	Proxies        []proxyPayload     `json:"proxies"`
	Routes         proxyconfig.Routes `json:"routes"`
	DirectFallback bool               `json:"directFallback"`
}

// proxyPayload omits Password to keep the stored password of the proxy with
// the same id; an empty string clears it.
type proxyPayload struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Kind     string  `json:"kind"`
	Scheme   string  `json:"scheme"`
	Host     string  `json:"host"`
	Port     int     `json:"port"`
	Username string  `json:"username"`
	Password *string `json:"password"`
}

// proxyConfigStore caches the stored proxy configuration. It loads on first
// use and is replaced after a committed settings change.
type proxyConfigStore struct {
	load func(context.Context) (proxyconfig.Config, error)
	// writeMu serializes proxy writes from their transaction through set, so
	// the cache publishes configurations in commit order.
	writeMu sync.Mutex

	mu     sync.Mutex
	loaded bool
	config proxyconfig.Config
}

func (store *proxyConfigStore) get(ctx context.Context) (proxyconfig.Config, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.loaded {
		config, err := store.load(ctx)
		if err != nil {
			return proxyconfig.Config{}, err
		}
		store.config = config
		store.loaded = true
	}
	return store.config, nil
}

func (store *proxyConfigStore) set(config proxyconfig.Config) {
	store.mu.Lock()
	store.config = config
	store.loaded = true
	store.mu.Unlock()
}

func (s *Server) loadProxyConfig(ctx context.Context) (proxyconfig.Config, error) {
	if s.db == nil {
		// A server without a database has no stored proxies.
		return proxyconfig.FromLegacyURL("")
	}
	return loadProxyConfigFrom(ctx, s.db)
}

type settingQueryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func loadProxyConfigFrom(ctx context.Context, db settingQueryer) (proxyconfig.Config, error) {
	var raw string
	err := db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", outboundProxySetting).Scan(&raw)
	if err == nil {
		var stored proxyconfig.Config
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return proxyconfig.Config{}, errProxyConfigUnavailable
		}
		normalized, err := proxyconfig.Normalize(stored, nil)
		if err != nil {
			return proxyconfig.Config{}, errProxyConfigUnavailable
		}
		return normalized, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return proxyconfig.Config{}, err
	}
	err = db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", legacyMetadataProxySetting).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return proxyconfig.FromLegacyURL("")
	}
	if err != nil {
		return proxyconfig.Config{}, err
	}
	var legacy string
	if err := json.Unmarshal([]byte(raw), &legacy); err != nil {
		return proxyconfig.Config{}, errProxyConfigUnavailable
	}
	config, err := proxyconfig.FromLegacyURL(legacy)
	if err != nil {
		return proxyconfig.Config{}, errProxyConfigUnavailable
	}
	return config, nil
}

func (s *Server) proxySettingsResponse(config proxyconfig.Config) proxySettingsResponse {
	proxies := make([]proxyResponse, 0, len(config.Proxies))
	for _, proxy := range config.Proxies {
		proxies = append(proxies, proxyResponse{
			ID:          proxy.ID,
			Name:        proxy.Name,
			Kind:        proxy.Kind,
			Scheme:      proxy.Scheme,
			Host:        proxy.Host,
			Port:        proxy.Port,
			Username:    proxy.Username,
			HasPassword: proxy.Password != "",
		})
	}
	routes := proxyconfig.Routes{
		DLsite:  nonNilRoute(config.Routes.DLsite),
		Remote:  nonNilRoute(config.Routes.Remote),
		Other:   nonNilRoute(config.Routes.Other),
		Sources: map[int64]proxyconfig.SourceRoute{},
	}
	for id, route := range config.Routes.Sources {
		if route.ProxyIDs == nil {
			route.ProxyIDs = []string{}
		}
		routes.Sources[id] = route
	}
	return proxySettingsResponse{
		HostAddress:    s.cfg.HostProxyAddress(),
		Proxies:        proxies,
		Routes:         routes,
		DirectFallback: config.DirectFallback,
	}
}

// nonNilRoute keeps an empty selection an array in API responses.
func nonNilRoute(route proxyconfig.Route) proxyconfig.Route {
	if route.ProxyIDs == nil {
		route.ProxyIDs = []string{}
	}
	return route
}

// applyProxySettings validates a submitted proxy configuration against the
// stored one and writes it in tx. The caller publishes the returned config to
// the store after commit.
func applyProxySettings(ctx context.Context, tx *sql.Tx, payload proxySettingsPayload) (proxyconfig.Config, error) {
	previous, err := loadProxyConfigFrom(ctx, tx)
	if err != nil && !errors.Is(err, errProxyConfigUnavailable) {
		return proxyconfig.Config{}, err
	}
	passwords := make(map[string]string, len(previous.Proxies))
	for _, proxy := range previous.Proxies {
		passwords[proxy.ID] = proxy.Password
	}
	submitted := proxyconfig.Config{
		Routes:         payload.Routes,
		Proxies:        make([]proxyconfig.Proxy, 0, len(payload.Proxies)),
		DirectFallback: payload.DirectFallback,
	}
	for _, proxy := range payload.Proxies {
		password := passwords[proxy.ID]
		if proxy.ID == "" {
			password = ""
		}
		if proxy.Password != nil {
			password = *proxy.Password
		}
		submitted.Proxies = append(submitted.Proxies, proxyconfig.Proxy{
			ID:       proxy.ID,
			Name:     proxy.Name,
			Kind:     proxy.Kind,
			Scheme:   proxy.Scheme,
			Host:     proxy.Host,
			Port:     proxy.Port,
			Username: proxy.Username,
			Password: password,
		})
	}
	remoteSources, err := remoteSourceIDs(ctx, tx)
	if err != nil {
		return proxyconfig.Config{}, err
	}
	config, err := proxyconfig.Normalize(submitted, func(id int64) bool { return remoteSources[id] })
	if err != nil {
		var invalidErr *proxyconfig.InvalidError
		if errors.As(err, &invalidErr) {
			return proxyconfig.Config{}, invalidSettings(invalidErr.Error())
		}
		return proxyconfig.Config{}, err
	}
	if err := writeProxyConfig(ctx, tx, config); err != nil {
		return proxyconfig.Config{}, err
	}
	return config, nil
}

func writeProxyConfig(ctx context.Context, tx *sql.Tx, config proxyconfig.Config) error {
	encoded, err := json.Marshal(config)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json)
		VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = CURRENT_TIMESTAMP
	`, outboundProxySetting, string(encoded)); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM app_setting WHERE key = ?", legacyMetadataProxySetting)
	return err
}

func remoteSourceIDs(ctx context.Context, tx *sql.Tx) (map[int64]bool, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM file_source WHERE source_type IN (?, ?)", sourceTypeKikoeruCompatible, sourceTypeKikoeruCompatible178)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = true
	}
	return ids, rows.Err()
}

// forgetSourceProxyRoute removes a deleted source's override so a later
// source that reuses its id starts from the remote-source route.
func (s *Server) forgetSourceProxyRoute(ctx context.Context, sourceID int64) error {
	s.proxyConfig.writeMu.Lock()
	defer s.proxyConfig.writeMu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var raw string
	err = tx.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", outboundProxySetting).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	config, err := loadProxyConfigFrom(ctx, tx)
	if err != nil {
		return err
	}
	if _, ok := config.Routes.Sources[sourceID]; !ok {
		return nil
	}
	delete(config.Routes.Sources, sourceID)
	if err := writeProxyConfig(ctx, tx, config); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.proxyConfig.set(config)
	return nil
}

// proxyRoute is the resolved proxy choice for one request: proxies in the
// order to try them, and whether a direct connection is the last resort. No
// proxies means a direct connection.
type proxyRoute struct {
	proxies        []*url.URL
	directFallback bool
}

// resolveProxyRoute resolves the proxy route for a request of scope.
func (s *Server) resolveProxyRoute(ctx context.Context, scope proxyconfig.Scope, sourceID int64) (proxyRoute, error) {
	config, err := s.proxyConfig.get(ctx)
	if err != nil {
		return proxyRoute{}, errProxyConfigUnavailable
	}
	proxies := config.Resolve(scope, sourceID)
	route := proxyRoute{
		proxies:        make([]*url.URL, 0, len(proxies)),
		directFallback: config.DirectFallback && len(proxies) > 0,
	}
	for _, proxy := range proxies {
		parsed, err := proxy.URL(s.cfg.HostProxyAddress())
		if err != nil {
			return proxyRoute{}, errProxyConfigUnavailable
		}
		route.proxies = append(route.proxies, parsed)
	}
	return route, nil
}

// key identifies a resolved route, including proxy credentials, without
// keeping them readable in transport cache keys.
func (route proxyRoute) key() string {
	if len(route.proxies) == 0 {
		return "direct"
	}
	hash := sha256.New()
	if route.directFallback {
		hash.Write([]byte("fallback"))
		hash.Write([]byte{0})
	}
	for _, proxy := range route.proxies {
		hash.Write([]byte(proxy.String()))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// proxiedTransport builds one policy transport per proxy behind a priority
// failover, optionally ending in a direct fallback, or a direct transport
// when the route has no proxies. Every route shares the same destination
// rules; only the dialed endpoint differs.
func proxiedTransport(route proxyRoute, policyFor func(*url.URL) (*outbound.Policy, error)) (http.RoundTripper, error) {
	direct := func() (http.RoundTripper, error) {
		policy, err := policyFor(nil)
		if err != nil {
			return nil, err
		}
		return policy.Transport(), nil
	}
	if len(route.proxies) == 0 {
		return direct()
	}
	routes := make([]http.RoundTripper, 0, len(route.proxies))
	for _, proxy := range route.proxies {
		policy, err := policyFor(proxy)
		if err != nil {
			return nil, err
		}
		routes = append(routes, policy.Transport())
	}
	if route.directFallback {
		fallback, err := direct()
		if err != nil {
			return nil, err
		}
		return outbound.NewFailoverTransportWithFallback(fallback, routes...), nil
	}
	return outbound.NewFailoverTransport(routes...), nil
}

// metadataTransport routes built-in DLsite requests through the proxies the
// DLsite route currently selects. It rebuilds when that selection changes
// and closes the previous transport's idle connections. URL, redirect, and
// address checks come from the same DLsite outbound policy with or without a
// proxy.
type metadataTransport struct {
	policyFor func(*url.URL) (*outbound.Policy, error)
	resolve   func(context.Context) (proxyRoute, error)

	mu        sync.Mutex
	key       string
	transport http.RoundTripper
}

func newMetadataTransport(endpoints dlsite.Endpoints, resolve func(context.Context) (proxyRoute, error)) *metadataTransport {
	return &metadataTransport{policyFor: endpoints.Policy, resolve: resolve}
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
	route, err := t.resolve(ctx)
	if err != nil {
		return nil, err
	}
	key := route.key()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.transport != nil && t.key == key {
		return t.transport, nil
	}
	transport, err := proxiedTransport(route, t.policyFor)
	if err != nil {
		return nil, errProxyConfigUnavailable
	}
	closeIdleConnections(t.transport)
	t.transport = transport
	t.key = key
	return transport, nil
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
// use the built-in destination policy and whose transport follows the DLsite
// proxy route.
func newMetadataHTTPClient(endpoints dlsite.Endpoints, transport http.RoundTripper) *http.Client {
	policy, err := endpoints.Policy(nil)
	if err != nil {
		panic("invalid built-in metadata destination policy")
	}
	return policy.Client(transport, dlsite.RequestTimeout)
}

// Package proxyconfig models the administrator's outbound forward proxies:
// an ordered proxy list tried by priority, and the routes that decide which
// proxies built-in DLsite metadata, remote sources, and other outbound
// requests use. It validates stored and submitted configuration and resolves
// proxy URLs; transports and persistence live with their callers.
package proxyconfig

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yexca/kikoto/backend/internal/outbound"
)

const (
	// KindHost is a proxy on the machine that runs Kikoto. Its address comes
	// from the runtime (the container host gateway) rather than from input.
	KindHost = "host"
	// KindCustom is a proxy at an administrator-entered address.
	KindCustom = "custom"

	// SourceInherit follows the remote-source route.
	SourceInherit = "inherit"
	// SourceDirect connects directly regardless of the remote-source route.
	SourceDirect = "direct"
	// SourceProxy uses the source's own proxy selection.
	SourceProxy = "proxy"

	// MaxProxies bounds the proxy list and therefore failover attempts.
	MaxProxies        = 8
	maxSourceRoutes   = 256
	maxNameLength     = 64
	maxUsernameLength = 255
	maxPasswordLength = 255
)

// Scope names a class of outbound requests.
type Scope string

const (
	ScopeDLsite Scope = "dlsite"
	ScopeRemote Scope = "remote"
	// ScopeOther covers outbound requests that are neither DLsite metadata
	// nor a configured remote source, such as the update check.
	ScopeOther Scope = "other"
)

// Proxy is one forward proxy. Host is empty for KindHost.
type Proxy struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Kind     string `json:"kind"`
	Scheme   string `json:"scheme"`
	Host     string `json:"host,omitempty"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// Route enables proxies for a scope. An empty ProxyIDs selects every proxy;
// either way proxies are tried in list priority order.
type Route struct {
	Enabled  bool     `json:"enabled"`
	ProxyIDs []string `json:"proxyIds"`
}

// SourceRoute overrides the remote-source route for one configured source.
type SourceRoute struct {
	Mode     string   `json:"mode"`
	ProxyIDs []string `json:"proxyIds"`
}

type Routes struct {
	DLsite Route `json:"dlsite"`
	Remote Route `json:"remote"`
	Other  Route `json:"other"`
	// Sources holds per-source overrides keyed by file source id. Sources
	// without an entry inherit the remote-source route.
	Sources map[int64]SourceRoute `json:"sources"`
}

type Config struct {
	Proxies []Proxy `json:"proxies"`
	Routes  Routes  `json:"routes"`
	// DirectFallback retries a proxied request with a direct connection
	// after every proxy it tried failed to answer.
	DirectFallback bool `json:"directFallback"`
}

// InvalidError reports administrator input that cannot be saved. Its message
// never includes credentials.
type InvalidError struct{ message string }

func (err *InvalidError) Error() string { return err.message }

func invalid(format string, args ...any) error {
	return &InvalidError{message: fmt.Sprintf(format, args...)}
}

var proxyIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Normalize validates a configuration, assigns ids to proxies without one,
// and canonicalizes routes: proxy selections are pruned to existing proxies
// in priority order, inherit overrides are dropped, and overrides for sources
// that knownSource rejects are removed.
func Normalize(config Config, knownSource func(int64) bool) (Config, error) {
	if len(config.Proxies) > MaxProxies {
		return Config{}, invalid("at most %d proxies can be configured", MaxProxies)
	}
	normalized := Config{Proxies: make([]Proxy, 0, len(config.Proxies)), DirectFallback: config.DirectFallback}
	seen := make(map[string]bool, len(config.Proxies))
	for index, proxy := range config.Proxies {
		next, err := normalizeProxy(proxy)
		if err != nil {
			return Config{}, invalid("proxy %d: %s", index+1, err.Error())
		}
		if next.ID == "" {
			next.ID = newProxyID(seen)
		}
		if seen[next.ID] {
			return Config{}, invalid("proxy %d: duplicate id", index+1)
		}
		seen[next.ID] = true
		normalized.Proxies = append(normalized.Proxies, next)
	}

	var err error
	if normalized.Routes.DLsite, err = normalized.normalizeRoute(config.Routes.DLsite, "DLsite"); err != nil {
		return Config{}, err
	}
	if normalized.Routes.Remote, err = normalized.normalizeRoute(config.Routes.Remote, "remote source"); err != nil {
		return Config{}, err
	}
	if normalized.Routes.Other, err = normalized.normalizeRoute(config.Routes.Other, "other"); err != nil {
		return Config{}, err
	}
	if len(config.Routes.Sources) > maxSourceRoutes {
		return Config{}, invalid("too many source proxy overrides")
	}
	normalized.Routes.Sources = map[int64]SourceRoute{}
	for id, route := range config.Routes.Sources {
		if id <= 0 {
			return Config{}, invalid("source proxy override has an invalid source id")
		}
		switch route.Mode {
		case "", SourceInherit:
			continue
		case SourceDirect:
			route.ProxyIDs = []string{}
		case SourceProxy:
			if len(normalized.Proxies) == 0 {
				return Config{}, invalid("a source can use a proxy only after a proxy is added")
			}
			route.ProxyIDs = normalized.selection(route.ProxyIDs)
		default:
			return Config{}, invalid("source proxy override mode must be inherit, direct, or proxy")
		}
		if knownSource != nil && !knownSource(id) {
			continue
		}
		normalized.Routes.Sources[id] = route
	}
	return normalized, nil
}

func normalizeProxy(proxy Proxy) (Proxy, error) {
	proxy.ID = strings.ToLower(strings.TrimSpace(proxy.ID))
	if proxy.ID != "" && !proxyIDPattern.MatchString(proxy.ID) {
		return Proxy{}, fmt.Errorf("id must use lowercase letters, digits, hyphens, or underscores")
	}
	proxy.Name = strings.TrimSpace(proxy.Name)
	if utf8.RuneCountInString(proxy.Name) > maxNameLength || hasControl(proxy.Name) {
		return Proxy{}, fmt.Errorf("name must be at most %d characters", maxNameLength)
	}
	proxy.Scheme = strings.ToLower(strings.TrimSpace(proxy.Scheme))
	switch proxy.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return Proxy{}, fmt.Errorf("protocol must be http, https, socks5, or socks5h")
	}
	if proxy.Port < 1 || proxy.Port > 65535 {
		return Proxy{}, fmt.Errorf("port must be between 1 and 65535")
	}
	switch proxy.Kind {
	case KindHost:
		proxy.Host = ""
	case KindCustom:
		host := strings.TrimSpace(proxy.Host)
		if host == "" || strings.ContainsAny(host, "/@?#") {
			return Proxy{}, fmt.Errorf("address must be a hostname or IP address")
		}
		if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
			host = "[" + host + "]"
		}
		parsed, err := outbound.ParseProxyURL(proxy.Scheme + "://" + host + ":" + strconv.Itoa(proxy.Port))
		if err != nil {
			return Proxy{}, fmt.Errorf("address must be a hostname or IP address")
		}
		proxy.Host = parsed.Hostname()
	default:
		return Proxy{}, fmt.Errorf("kind must be host or custom")
	}
	if len(proxy.Username) > maxUsernameLength || hasControl(proxy.Username) {
		return Proxy{}, fmt.Errorf("username must be at most %d characters", maxUsernameLength)
	}
	if len(proxy.Password) > maxPasswordLength || hasControl(proxy.Password) {
		return Proxy{}, fmt.Errorf("password must be at most %d characters", maxPasswordLength)
	}
	if proxy.Username == "" {
		proxy.Password = ""
	}
	return proxy, nil
}

func (config Config) normalizeRoute(route Route, label string) (Route, error) {
	if route.Enabled && len(config.Proxies) == 0 {
		return Route{}, invalid("the %s proxy route can be enabled only after a proxy is added", label)
	}
	return Route{Enabled: route.Enabled, ProxyIDs: config.selection(route.ProxyIDs)}, nil
}

// selection keeps ids that name an existing proxy, in list priority order.
// An empty result means every proxy.
func (config Config) selection(ids []string) []string {
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		wanted[strings.ToLower(strings.TrimSpace(id))] = true
	}
	selected := []string{}
	for _, proxy := range config.Proxies {
		if wanted[proxy.ID] {
			selected = append(selected, proxy.ID)
		}
	}
	return selected
}

// Resolve returns the proxies, in the order to try them, for a request of
// scope. sourceID selects a remote-source override and is ignored for other
// scopes. No proxies means a direct connection.
func (config Config) Resolve(scope Scope, sourceID int64) []Proxy {
	var route Route
	switch scope {
	case ScopeDLsite:
		route = config.Routes.DLsite
	case ScopeRemote:
		if override, ok := config.Routes.Sources[sourceID]; ok && sourceID > 0 {
			switch override.Mode {
			case SourceDirect:
				return nil
			case SourceProxy:
				return config.proxies(override.ProxyIDs)
			}
		}
		route = config.Routes.Remote
	case ScopeOther:
		route = config.Routes.Other
	}
	if !route.Enabled {
		return nil
	}
	return config.proxies(route.ProxyIDs)
}

func (config Config) proxies(ids []string) []Proxy {
	if len(ids) == 0 {
		return append([]Proxy(nil), config.Proxies...)
	}
	wanted := make(map[string]bool, len(ids))
	for _, id := range ids {
		wanted[id] = true
	}
	selected := make([]Proxy, 0, len(ids))
	for _, proxy := range config.Proxies {
		if wanted[proxy.ID] {
			selected = append(selected, proxy)
		}
	}
	return selected
}

// URL builds the proxy URL, including credentials, for an outbound policy.
// hostAddress replaces the address of a KindHost proxy.
func (proxy Proxy) URL(hostAddress string) (*url.URL, error) {
	host := proxy.Host
	if proxy.Kind == KindHost {
		host = hostAddress
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	parsed, err := outbound.ParseProxyURL(proxy.Scheme + "://" + host + ":" + strconv.Itoa(proxy.Port))
	if err != nil {
		return nil, err
	}
	if proxy.Username != "" {
		parsed.User = url.UserPassword(proxy.Username, proxy.Password)
	}
	return parsed, nil
}

// FromLegacyURL converts the former single metadata proxy setting into a
// custom proxy used by the DLsite route. An empty value is an empty config.
func FromLegacyURL(value string) (Config, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return Config{Routes: Routes{Sources: map[int64]SourceRoute{}}}, nil
	}
	parsed, err := outbound.ParseProxyURL(value)
	if err != nil {
		return Config{}, err
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		return Config{}, err
	}
	return Config{
		Proxies: []Proxy{{ID: "legacy", Kind: KindCustom, Scheme: parsed.Scheme, Host: parsed.Hostname(), Port: port}},
		Routes: Routes{
			DLsite:  Route{Enabled: true, ProxyIDs: []string{}},
			Remote:  Route{ProxyIDs: []string{}},
			Other:   Route{ProxyIDs: []string{}},
			Sources: map[int64]SourceRoute{},
		},
	}, nil
}

func newProxyID(taken map[string]bool) string {
	for {
		buffer := make([]byte, 4)
		if _, err := rand.Read(buffer); err != nil {
			panic("proxy id entropy unavailable")
		}
		id := "p" + hex.EncodeToString(buffer)
		if !taken[id] {
			return id
		}
	}
}

func hasControl(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}

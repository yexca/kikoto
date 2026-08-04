package outbound

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultConnectTimeout        = 10 * time.Second
	defaultResponseHeaderTimeout = 30 * time.Second
	defaultResponseReadTimeout   = 60 * time.Second
	maxResolvedAddresses         = 32
	maxResponseHeaderBytes       = 1 << 20
	maxRedirects                 = 10
)

// Destination declares an origin that outbound requests may reach. Private
// addresses are allowed only for origins explicitly configured by an operator.
type Destination struct {
	URL          string
	AllowPrivate bool
}

// Resolver is the subset of net.Resolver used by Policy.
type Resolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// DialContextFunc matches net.Dialer's DialContext method.
type DialContextFunc func(ctx context.Context, network string, address string) (net.Conn, error)

// Options exposes network dependencies for deterministic security tests.
type Options struct {
	Resolver            Resolver
	DialContext         DialContextFunc
	ConnectTimeout      time.Duration
	ResponseReadTimeout time.Duration
}

type Policy struct {
	origins        map[string]originRule
	endpoints      map[string]endpointRule
	resolver       Resolver
	dialContext    DialContextFunc
	connectTimeout time.Duration
	readTimeout    time.Duration
}

type originRule struct {
	allowPrivate bool
}

type endpointRule struct {
	allowPrivate bool
}

type policyTransport struct {
	policy *Policy
	base   *http.Transport
}

type timeoutBody struct {
	body       io.ReadCloser
	timeout    time.Duration
	mu         sync.Mutex
	timer      *time.Timer
	generation uint64
	timedOut   bool
	closed     bool
	closeOnce  sync.Once
	closeErr   error
}

var (
	// ErrPolicyViolation identifies a permanent URL, origin, redirect, or
	// address-policy rejection that should not be retried.
	ErrPolicyViolation = errors.New("outbound policy violation")
	// ErrResponseReadTimeout identifies a response body that stopped making
	// progress beyond the configured read-idle bound.
	ErrResponseReadTimeout = errors.New("outbound response body read timed out")
)

type policyViolation struct {
	detail string
}

func (err policyViolation) Error() string {
	return err.detail
}

func (err policyViolation) Unwrap() error {
	return ErrPolicyViolation
}

func violation(detail string) error {
	return policyViolation{detail: detail}
}

// NewPolicy validates an explicit destination allowlist and prepares a
// DNS-pinning policy for it.
func NewPolicy(destinations []Destination, options Options) (*Policy, error) {
	policy := &Policy{
		origins:        make(map[string]originRule),
		endpoints:      make(map[string]endpointRule),
		resolver:       options.Resolver,
		dialContext:    options.DialContext,
		connectTimeout: options.ConnectTimeout,
		readTimeout:    options.ResponseReadTimeout,
	}
	if policy.resolver == nil {
		policy.resolver = net.DefaultResolver
	}
	if policy.connectTimeout <= 0 {
		policy.connectTimeout = defaultConnectTimeout
	}
	if policy.readTimeout <= 0 {
		policy.readTimeout = defaultResponseReadTimeout
	}
	if policy.dialContext == nil {
		dialer := &net.Dialer{Timeout: policy.connectTimeout, KeepAlive: 30 * time.Second}
		policy.dialContext = dialer.DialContext
	}

	for _, destination := range destinations {
		parsed, err := ParseHTTPURL(destination.URL)
		if err != nil {
			return nil, err
		}
		origin, endpoint, err := canonicalDestination(parsed)
		if err != nil {
			return nil, err
		}
		if existing, ok := policy.origins[origin]; ok && existing.allowPrivate != destination.AllowPrivate {
			return nil, violation("outbound origin has conflicting address rules")
		}
		if existing, ok := policy.endpoints[endpoint]; ok && existing.allowPrivate != destination.AllowPrivate {
			return nil, violation("outbound endpoint has conflicting address rules")
		}
		policy.origins[origin] = originRule{allowPrivate: destination.AllowPrivate}
		policy.endpoints[endpoint] = endpointRule{allowPrivate: destination.AllowPrivate}
	}
	if len(policy.origins) == 0 {
		return nil, violation("outbound destination allowlist is empty")
	}
	return policy, nil
}

// ParseHTTPURL accepts only absolute HTTP(S) URLs without embedded
// credentials. It is also used when validating persisted operator input.
func ParseHTTPURL(value string) (*url.URL, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, violation("outbound URL is empty")
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return nil, violation("outbound URL is invalid")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, violation("outbound URL must use HTTP or HTTPS")
	}
	if parsed.Opaque != "" || parsed.Host == "" || parsed.Hostname() == "" {
		return nil, violation("outbound URL must be absolute")
	}
	if parsed.User != nil {
		return nil, violation("outbound URL must not contain credentials")
	}
	if parsed.Fragment != "" {
		return nil, violation("outbound URL must not contain a fragment")
	}
	if _, _, err := canonicalDestination(parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

// CanonicalOrigin returns a normalized scheme, hostname, and effective port
// for an already parsed HTTP(S) URL.
func CanonicalOrigin(value *url.URL) (string, error) {
	if value == nil {
		return "", violation("outbound URL is missing")
	}
	parsed, err := ParseHTTPURL(value.String())
	if err != nil {
		return "", err
	}
	origin, _, err := canonicalDestination(parsed)
	return origin, err
}

// ValidateURL verifies that a request remains within the declared origin
// allowlist. Address validation happens again when a new connection is dialed.
func (p *Policy) ValidateURL(value *url.URL) error {
	if value == nil {
		return violation("outbound URL is missing")
	}
	origin, err := CanonicalOrigin(value)
	if err != nil {
		return err
	}
	if _, ok := p.origins[origin]; !ok {
		return violation("outbound URL origin is not allowed")
	}
	return nil
}

// Transport returns a transport that validates every request, resolves each
// hostname once per connection, validates the complete answer set, and dials a
// validated numeric address rather than resolving the hostname again.
func (p *Policy) Transport() http.RoundTripper {
	base := &http.Transport{
		Proxy:                  nil,
		DialContext:            p.dial,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           32,
		MaxIdleConnsPerHost:    4,
		MaxConnsPerHost:        8,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  defaultResponseHeaderTimeout,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: maxResponseHeaderBytes,
	}
	return &policyTransport{policy: p, base: base}
}

// Client builds an HTTP client with the policy's redirect contract. A caller
// may wrap Transport (for example, with a per-origin request gate) and pass the
// wrapper here.
func (p *Policy) Client(transport http.RoundTripper, timeout time.Duration) *http.Client {
	if transport == nil {
		transport = p.Transport()
	}
	return &http.Client{
		Transport:     transport,
		Timeout:       timeout,
		CheckRedirect: p.checkRedirect,
	}
}

func (t *policyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil {
		return nil, violation("outbound request is missing")
	}
	if err := t.policy.ValidateURL(request.URL); err != nil {
		return nil, err
	}
	if request.Host != "" {
		requestOrigin, err := CanonicalOrigin(request.URL)
		if err != nil {
			return nil, err
		}
		hostOrigin, err := CanonicalOrigin(&url.URL{Scheme: request.URL.Scheme, Host: request.Host})
		if err != nil || requestOrigin != hostOrigin {
			return nil, violation("outbound request Host does not match its URL origin")
		}
	}
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return nil, err
	}
	if response.Body != nil {
		response.Body = &timeoutBody{body: response.Body, timeout: t.policy.readTimeout}
	}
	return response, nil
}

func (t *policyTransport) CloseIdleConnections() {
	t.base.CloseIdleConnections()
}

func (body *timeoutBody) Read(buffer []byte) (int, error) {
	body.mu.Lock()
	if body.timedOut {
		body.mu.Unlock()
		return 0, ErrResponseReadTimeout
	}
	if body.closed {
		body.mu.Unlock()
		return 0, net.ErrClosed
	}
	body.generation++
	generation := body.generation
	body.timer = time.AfterFunc(body.timeout, func() {
		body.expire(generation)
	})
	timer := body.timer
	body.mu.Unlock()

	read, err := body.body.Read(buffer)
	body.mu.Lock()
	if body.generation == generation {
		body.timer = nil
		timer.Stop()
	}
	timedOut := body.timedOut
	body.mu.Unlock()
	if timedOut && (err != nil || read == 0) {
		return read, ErrResponseReadTimeout
	}
	return read, err
}

func (body *timeoutBody) Close() error {
	body.mu.Lock()
	body.closed = true
	if body.timer != nil {
		body.timer.Stop()
		body.timer = nil
	}
	body.mu.Unlock()
	body.closeUnderlying()
	return body.closeErr
}

func (body *timeoutBody) expire(generation uint64) {
	body.mu.Lock()
	if body.closed || body.timedOut || body.generation != generation {
		body.mu.Unlock()
		return
	}
	body.timedOut = true
	body.timer = nil
	body.mu.Unlock()
	body.closeUnderlying()
}

func (body *timeoutBody) closeUnderlying() {
	body.closeOnce.Do(func() {
		body.closeErr = body.body.Close()
	})
}

func (p *Policy) checkRedirect(request *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return violation("outbound redirect limit exceeded")
	}
	if err := p.ValidateURL(request.URL); err != nil {
		return err
	}
	if len(via) == 0 {
		return nil
	}
	previousOrigin, _, err := canonicalDestination(via[len(via)-1].URL)
	if err != nil {
		return err
	}
	redirectOrigin, _, err := canonicalDestination(request.URL)
	if err != nil {
		return err
	}
	if previousOrigin != redirectOrigin {
		request.Header.Del("Authorization")
		request.Header.Del("Cookie")
		request.Header.Del("Proxy-Authorization")
		request.Header.Del("Referer")
		request.Host = ""
	}
	return nil
}

func (p *Policy) dial(ctx context.Context, network string, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, violation("outbound connection address is invalid")
	}
	endpoint, err := canonicalEndpoint(host, port)
	if err != nil {
		return nil, err
	}
	rule, ok := p.endpoints[endpoint]
	if !ok {
		return nil, violation("outbound connection endpoint is not allowed")
	}

	dialCtx, cancel := context.WithTimeout(ctx, p.connectTimeout)
	defer cancel()
	addresses, err := p.resolve(dialCtx, host)
	if err != nil {
		return nil, err
	}
	if len(addresses) == 0 {
		return nil, errors.New("outbound hostname resolved to no addresses")
	}
	if len(addresses) > maxResolvedAddresses {
		return nil, violation("outbound hostname resolved to too many addresses")
	}
	for _, resolved := range addresses {
		if err := validateAddress(resolved, rule.allowPrivate); err != nil {
			return nil, err
		}
	}

	var lastErr error
	for _, resolved := range addresses {
		if network == "tcp4" && !resolved.Is4() || network == "tcp6" && !resolved.Is6() {
			continue
		}
		connection, dialErr := p.dialContext(dialCtx, network, net.JoinHostPort(resolved.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		lastErr = dialErr
	}
	if lastErr == nil {
		lastErr = errors.New("outbound hostname has no compatible address")
	}
	return nil, lastErr
}

func (p *Policy) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if parsed, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{parsed.Unmap()}, nil
	}
	resolved, err := p.resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, errors.New("outbound hostname could not be resolved")
	}
	addresses := make([]netip.Addr, 0, len(resolved))
	seen := make(map[netip.Addr]bool, len(resolved))
	for _, candidate := range resolved {
		if candidate.Zone != "" {
			return nil, violation("outbound DNS result contains an unsupported address zone")
		}
		address, ok := netip.AddrFromSlice(candidate.IP)
		if !ok {
			return nil, violation("outbound DNS result contains an invalid address")
		}
		address = address.Unmap()
		if !seen[address] {
			seen[address] = true
			addresses = append(addresses, address)
		}
	}
	return addresses, nil
}

func validateAddress(address netip.Addr, allowPrivate bool) error {
	address = address.Unmap()
	if !address.IsValid() || isUnusableAddress(address) {
		return violation("outbound destination resolved to an unusable address")
	}
	if allowPrivate {
		return nil
	}
	if isNonPublicAddress(address) {
		return violation("outbound destination resolved to a private or reserved address")
	}
	return nil
}

func isNonPublicAddress(address netip.Addr) bool {
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || address.IsLinkLocalMulticast() {
		return true
	}
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func isUnusableAddress(address netip.Addr) bool {
	if address.IsUnspecified() || address.IsMulticast() {
		return true
	}
	for _, prefix := range unusablePrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

var unusablePrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("100::/64"),
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
	netip.MustParsePrefix("5f00::/16"),
}

func canonicalDestination(value *url.URL) (string, string, error) {
	if value == nil {
		return "", "", violation("outbound URL is missing")
	}
	scheme := strings.ToLower(value.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", violation("outbound URL must use HTTP or HTTPS")
	}
	host, err := canonicalHost(value.Hostname())
	if err != nil {
		return "", "", err
	}
	port := value.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	endpoint, err := canonicalEndpoint(host, port)
	if err != nil {
		return "", "", err
	}
	return scheme + "://" + endpoint, endpoint, nil
}

func canonicalEndpoint(host string, port string) (string, error) {
	host, err := canonicalHost(host)
	if err != nil {
		return "", err
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", violation("outbound URL port is invalid")
	}
	return net.JoinHostPort(host, strconv.Itoa(portNumber)), nil
}

func canonicalHost(host string) (string, error) {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "" || strings.Contains(host, "%") {
		return "", violation("outbound URL hostname is invalid")
	}
	if address, err := netip.ParseAddr(host); err == nil {
		return address.Unmap().String(), nil
	}
	if len(host) > 253 {
		return "", violation("outbound URL hostname is invalid")
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", violation("outbound URL hostname is invalid")
		}
		for _, character := range label {
			if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' || character == '_' {
				continue
			}
			return "", violation("outbound URL hostname is invalid")
		}
	}
	return host, nil
}

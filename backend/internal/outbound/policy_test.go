package outbound

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type resolverFunc func(ctx context.Context, host string) ([]net.IPAddr, error)

func (resolve resolverFunc) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return resolve(ctx, host)
}

func TestParseHTTPURLRejectsUnsafeValues(t *testing.T) {
	tests := []string{
		"",
		"/relative/path",
		"file:///tmp/example",
		"ftp://example.invalid/file",
		"https://synthetic-user:synthetic-password@example.invalid/file",
		"https://example.invalid/file#fragment",
		"https://example.invalid:70000/file",
	}
	for _, value := range tests {
		t.Run(value, func(t *testing.T) {
			if _, err := ParseHTTPURL(value); err == nil {
				t.Fatalf("ParseHTTPURL(%q) unexpectedly succeeded", value)
			}
		})
	}
}

func TestPolicyUsesCanonicalExactOrigins(t *testing.T) {
	policy, err := NewPolicy([]Destination{{URL: "HTTPS://source.test"}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	allowed, _ := url.Parse("https://SOURCE.test:443/path")
	if err := policy.ValidateURL(allowed); err != nil {
		t.Fatalf("canonical default-port origin was rejected: %v", err)
	}
	if origin, err := CanonicalOrigin(allowed); err != nil || origin != "https://source.test:443" {
		t.Fatalf("canonical origin = %q, error = %v", origin, err)
	}
	for _, value := range []string{
		"http://source.test:443/path",
		"https://source.test:444/path",
		"https://other.test/path",
	} {
		candidate, _ := url.Parse(value)
		if err := policy.ValidateURL(candidate); err == nil {
			t.Fatalf("non-matching origin %q was accepted", value)
		} else if !errors.Is(err, ErrPolicyViolation) {
			t.Fatalf("origin error = %v, want policy violation", err)
		}
	}
}

func TestPublicPolicyRejectsPrivateAndReservedAddresses(t *testing.T) {
	addresses := []string{
		"127.0.0.1",
		"10.0.0.1",
		"169.254.1.1",
		"100.64.0.1",
		"192.0.2.1",
		"198.18.0.1",
		"203.0.113.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
	}
	for _, value := range addresses {
		t.Run(value, func(t *testing.T) {
			if err := validateAddress(netip.MustParseAddr(value), false); err == nil {
				t.Fatalf("public policy unexpectedly accepted %s", value)
			}
		})
	}
}

func TestPolicyRejectsCompleteDNSAnswerWhenAnyAddressIsPrivate(t *testing.T) {
	var dialed atomic.Bool
	policy, err := NewPolicy([]Destination{{URL: "https://source.test"}}, Options{
		Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("93.184.216.34")},
				{IP: net.ParseIP("127.0.0.1")},
			}, nil
		}),
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			dialed.Store(true)
			return nil, errors.New("unexpected dial")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policy.dial(context.Background(), "tcp", "source.test:443"); err == nil {
		t.Fatal("mixed public/private DNS answer unexpectedly succeeded")
	}
	if dialed.Load() {
		t.Fatal("dialer was called before the complete DNS answer was validated")
	}
}

func TestConfiguredPrivateOriginIsAllowed(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	defer remote.Close()

	policy, err := NewPolicy([]Destination{{URL: remote.URL, AllowPrivate: true}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	response, err := policy.Client(nil, time.Second).Get(remote.URL)
	if err != nil {
		t.Fatalf("configured private origin: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
}

func TestTransportRejectsMismatchedHostOverride(t *testing.T) {
	var reached atomic.Bool
	remote := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		reached.Store(true)
	}))
	defer remote.Close()
	policy, err := NewPolicy([]Destination{{URL: remote.URL, AllowPrivate: true}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Host = "other.test"
	if _, err := policy.Client(nil, time.Second).Do(request); !errors.Is(err, ErrPolicyViolation) {
		t.Fatalf("Host override error = %v, want policy violation", err)
	}
	if reached.Load() {
		t.Fatal("request with a mismatched Host reached the configured endpoint")
	}
}

func TestRedirectRejectsOriginOutsideAllowlist(t *testing.T) {
	var escaped atomic.Bool
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		escaped.Store(true)
	}))
	defer destination.Close()
	middle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, destination.URL+"/escaped", http.StatusFound)
	}))
	defer middle.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, middle.URL+"/middle", http.StatusFound)
	}))
	defer origin.Close()

	policy, err := NewPolicy([]Destination{
		{URL: origin.URL, AllowPrivate: true},
		{URL: middle.URL, AllowPrivate: true},
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policy.Client(nil, time.Second).Get(origin.URL); err == nil {
		t.Fatal("redirect outside the allowlist unexpectedly succeeded")
	}
	if escaped.Load() {
		t.Fatal("request reached the redirect destination")
	}
}

func TestAllowedCrossOriginRedirectStripsCredentials(t *testing.T) {
	received := make(chan http.Header, 1)
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		received <- request.Header.Clone()
		_, _ = io.WriteString(w, "ok")
	}))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, destination.URL+"/next", http.StatusFound)
	}))
	defer origin.Close()

	policy, err := NewPolicy([]Destination{
		{URL: origin.URL, AllowPrivate: true},
		{URL: destination.URL, AllowPrivate: true},
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, origin.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer synthetic-token")
	request.Header.Set("Cookie", "session=synthetic")
	request.Header.Set("Proxy-Authorization", "Basic synthetic")
	response, err := policy.Client(nil, time.Second).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()

	headers := <-received
	for _, name := range []string{"Authorization", "Cookie", "Proxy-Authorization"} {
		if value := headers.Get(name); value != "" {
			t.Fatalf("%s leaked across origins: %q", name, value)
		}
	}
}

func TestRedirectRevalidatesEmbeddedCredentials(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		location := &url.URL{
			Scheme: "http",
			Host:   request.Host,
			Path:   "/next",
			User:   url.UserPassword("synthetic-user", "synthetic-password"),
		}
		http.Redirect(w, request, location.String(), http.StatusFound)
	}))
	defer origin.Close()

	policy, err := NewPolicy([]Destination{{URL: origin.URL, AllowPrivate: true}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := policy.Client(nil, time.Second).Get(origin.URL); err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("redirect error = %v, want embedded-credentials rejection", err)
	}
}

func TestTransportPinsDialToValidatedDNSAnswer(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Host, "source.test:") {
			t.Errorf("Host = %q, want source.test with the configured port", request.Host)
		}
		_, _ = io.WriteString(w, "pinned")
	}))
	defer remote.Close()
	parsed, err := url.Parse(remote.URL)
	if err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}

	var lookups atomic.Int32
	policy, err := NewPolicy([]Destination{{URL: "http://source.test:" + port, AllowPrivate: true}}, Options{
		Resolver: resolverFunc(func(_ context.Context, host string) ([]net.IPAddr, error) {
			if host != "source.test" {
				return nil, fmt.Errorf("resolved unexpected host %q", host)
			}
			if lookups.Add(1) == 1 {
				return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
			}
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.2")}}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	target := "http://source.test:" + port + "/media"
	response, err := policy.Client(nil, time.Second).Get(target)
	if err != nil {
		t.Fatalf("pinned request: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "pinned" {
		t.Fatalf("body = %q", body)
	}
	if got := lookups.Load(); got != 1 {
		t.Fatalf("DNS lookups = %d, want exactly one", got)
	}
}

func TestTransportBoundsResponseBodyReadIdleTime(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	defer remote.Close()

	policy, err := NewPolicy([]Destination{{URL: remote.URL, AllowPrivate: true}}, Options{
		ResponseReadTimeout: 25 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := policy.Client(nil, time.Second).Get(remote.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	started := time.Now()
	_, err = response.Body.Read(make([]byte, 1))
	if !errors.Is(err, ErrResponseReadTimeout) {
		t.Fatalf("read error = %v, want response read timeout", err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("read idle timeout took %s", elapsed)
	}
}

package outbound

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestNormalizeProxyBypassEntry(t *testing.T) {
	for value, want := range map[string]string{
		" LocalHost ":           "localhost",
		"host.docker.internal.": "host.docker.internal",
		".lan":                  "*.lan",
		"*.Home.Arpa":           "*.home.arpa",
		"127.1.2.3/8":           "127.0.0.0/8",
		"::ffff:127.0.0.0/104":  "127.0.0.0/8",
		"[::1]":                 "::1",
		"FC00::/7":              "fc00::/7",
		"127.0.0.1":             "127.0.0.1",
	} {
		if got, err := NormalizeProxyBypassEntry(value); err != nil || got != want {
			t.Errorf("%q = %q, %v; want %q", value, got, err, want)
		}
	}
	for _, value := range []string{"", "*", "*.", "nas:8080", "http://nas.test", "nas/path", "127.0.0.0/33", "fe80::1%eth0", "*.127.0.0.1"} {
		if got, err := NormalizeProxyBypassEntry(value); err == nil {
			t.Errorf("%q was accepted as %q", value, got)
		}
	}
	entries := make([]string, MaxProxyBypassEntries+1)
	for index := range entries {
		entries[index] = "localhost"
	}
	if _, err := NewProxyBypass(entries); err == nil {
		t.Error("an oversized bypass list was accepted")
	}
}

// A configured LAN service is reached through the proxy unless the bypass
// list names its host, a domain it belongs to, or a network its address is
// in; a bypassed request is pinned to the address validated before dialing.
func TestProxyBypassConnectsDirectlyOnlyToMatchedDestinations(t *testing.T) {
	var direct, proxied atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		direct.Add(1)
		_, _ = io.WriteString(w, "direct")
	}))
	defer target.Close()
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Add(1)
		http.Error(w, "refused", http.StatusForbidden)
	}))
	defer proxyServer.Close()
	targetURL, _ := url.Parse(target.URL)
	proxyURL, err := ParseProxyURL(proxyServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://nas.test:" + targetURL.Port()
	policy, err := NewPolicy([]Destination{{URL: origin, AllowPrivate: true}}, Options{
		Proxy: proxyURL,
		Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		entries []string
		direct  bool
	}{
		{nil, false},
		{[]string{"10.0.0.0/8", "*.lan", "nas.example.test"}, false},
		{[]string{"127.0.0.0/8"}, true},
		{[]string{"NAS.test"}, true},
		{[]string{".test"}, true},
	} {
		direct.Store(0)
		proxied.Store(0)
		bypass, err := NewProxyBypass(test.entries)
		if err != nil {
			t.Fatal(err)
		}
		client := policy.WithProxyBypass(bypass).Client(nil, time.Second)
		response, err := client.Get(origin + "/info")
		if err == nil {
			_ = response.Body.Close()
		}
		client.CloseIdleConnections()
		if test.direct && (err != nil || direct.Load() != 1 || proxied.Load() != 0) {
			t.Errorf("%v: error %v, direct %d, proxied %d; want a direct request", test.entries, err, direct.Load(), proxied.Load())
		}
		if !test.direct && (err == nil || direct.Load() != 0 || proxied.Load() != 1) {
			t.Errorf("%v: error %v, direct %d, proxied %d; want the proxy", test.entries, err, direct.Load(), proxied.Load())
		}
	}
}

// Bypassing the proxy never lets a destination reach an address its policy
// refuses.
func TestProxyBypassKeepsTheAddressRules(t *testing.T) {
	proxyURL, err := ParseProxyURL("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	var dialed atomic.Bool
	policy, err := NewPolicy(nil, Options{
		Proxy: proxyURL, AllowPublicOrigins: true,
		Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: testfixture.DocumentationIPv4()}}, nil
		}),
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			dialed.Store(true)
			return nil, errors.New("unexpected dial")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	bypass, err := NewProxyBypass([]string{"192.0.2.0/24", "returned.source.test"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = policy.WithProxyBypass(bypass).Client(nil, time.Second).Get("http://returned.source.test/file")
	if !errors.Is(err, ErrPolicyViolation) || dialed.Load() {
		t.Fatalf("request error = %v, dialed = %v; want the private address refused before dialing", err, dialed.Load())
	}
}

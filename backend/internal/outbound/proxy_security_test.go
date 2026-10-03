package outbound

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func publicTestResolver() Resolver {
	return resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: testfixture.PublicIPv4()}}, nil
	})
}

func TestPrivateOriginExceptionDoesNotCrossSchemes(t *testing.T) {
	for _, proxyValue := range []string{"", "http://127.0.0.1:1"} {
		var proxyURL *url.URL
		if proxyValue != "" {
			proxyURL, _ = ParseProxyURL(proxyValue)
		}
		var dialed atomic.Bool
		policy, err := NewPolicy([]Destination{{URL: "http://configured.source.test:443", AllowPrivate: true}}, Options{
			Proxy: proxyURL, AllowPublicOrigins: true,
			Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
				return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
			}),
			DialContext: func(context.Context, string, string) (net.Conn, error) {
				dialed.Store(true)
				return nil, errors.New("unexpected dial")
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = policy.Client(nil, time.Second).Get("https://configured.source.test:443/media")
		if !errors.Is(err, ErrPolicyViolation) || dialed.Load() {
			t.Fatalf("changed scheme inherited private-origin permission: error = %v, dialed = %t", err, dialed.Load())
		}
	}
}

func TestProxyRejectsPrivateAndMixedDestinationAddressesBeforeConnecting(t *testing.T) {
	for _, scheme := range []string{"http", "https", "socks5", "socks5h"} {
		for _, addresses := range [][]string{{"127.0.0.1"}, {net.IPv4(169, 254, 1, 1).String()}, {"::1"}, {"2001:db8::1"}, {testfixture.PublicIPv4().String(), net.IPv4(10, 0, 0, 1).String()}} {
			t.Run(scheme+"/"+strings.Join(addresses, ","), func(t *testing.T) {
				proxyURL, err := ParseProxyURL(scheme + "://127.0.0.1:1")
				if err != nil {
					t.Fatal(err)
				}
				var dialed atomic.Bool
				policy, err := NewPolicy(nil, Options{
					Proxy: proxyURL, AllowPublicOrigins: true,
					Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
						var result []net.IPAddr
						for _, address := range addresses {
							result = append(result, net.IPAddr{IP: net.ParseIP(address)})
						}
						return result, nil
					}),
					DialContext: func(context.Context, string, string) (net.Conn, error) {
						dialed.Store(true)
						return nil, errors.New("unexpected dial")
					},
				})
				if err != nil {
					t.Fatal(err)
				}
				for _, protocol := range []string{"http", "https"} {
					_, err := policy.Client(nil, time.Second).Get(protocol + "://returned.source.test/file")
					if !errors.Is(err, ErrPolicyViolation) || dialed.Load() {
						t.Fatalf("request error = %v, dialed = %v; want rejection before proxy connection", err, dialed.Load())
					}
				}
			})
		}
	}
}

func TestHTTPProxyPinsConfiguredPrivateDestinationAndPreservesHost(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Host, "source.test:") {
			t.Errorf("destination Host = %q", request.Host)
		}
		_, _ = io.WriteString(w, "pinned")
	}))
	defer target.Close()
	parsed, _ := url.Parse(target.URL)
	proxyServer := newTunnelProxy(t, parsed.Host, nil)
	defer proxyServer.Close()
	proxyURL, _ := ParseProxyURL(proxyServer.URL)
	var lookups atomic.Int32
	origin := "http://source.test:" + parsed.Port()
	policy, err := NewPolicy([]Destination{{URL: origin, AllowPrivate: true}}, Options{
		Proxy: proxyURL,
		Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
			address := "127.0.0.1"
			if lookups.Add(1) > 1 {
				address = "127.0.0.2"
			}
			return []net.IPAddr{{IP: net.ParseIP(address)}}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	client := policy.Client(nil, time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Get(origin + "/media?example=1")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil || string(body) != "pinned" || lookups.Load() != 1 {
		t.Fatalf("response = %q, error = %v, DNS lookups = %d", body, err, lookups.Load())
	}
}

func TestHTTPSProxyTunnelPreservesDestinationTLSVerification(t *testing.T) {
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "secure")
	}))
	defer target.Close()
	parsed, _ := url.Parse(target.URL)
	var connected atomic.Value
	proxyServer := newTunnelProxy(t, parsed.Host, &connected)
	defer proxyServer.Close()
	proxyURL, _ := ParseProxyURL(proxyServer.URL)
	// The httptest certificate covers example.com. DNS resolves it to the
	// synthetic listener, but the TLS handshake must still verify that name.
	origin := "https://example.com:" + parsed.Port()
	policy, err := NewPolicy([]Destination{{URL: origin, AllowPrivate: true}}, Options{
		Proxy: proxyURL,
		Resolver: resolverFunc(func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	transport := policy.Transport().(*policyTransport)
	roots := x509.NewCertPool()
	roots.AddCert(target.Certificate())
	transport.base.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	client := policy.Client(transport, time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Get(origin + "/file")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)
	if string(body) != "secure" || connected.Load() != parsed.Host {
		t.Fatalf("body = %q, CONNECT target = %v", body, connected.Load())
	}
}

func newTunnelProxy(t *testing.T, target string, connected *atomic.Value) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if connected != nil {
			connected.Store(request.Host)
		}
		if request.Method != http.MethodConnect || request.Host != target {
			http.Error(w, "invalid tunnel target", http.StatusBadRequest)
			return
		}
		upstream, err := net.DialTimeout("tcp", target, time.Second)
		if err != nil {
			http.Error(w, "unavailable", http.StatusBadGateway)
			return
		}
		connection, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		defer func() { _ = connection.Close(); _ = upstream.Close() }()
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		go func() { _, _ = io.Copy(upstream, buffered); _ = upstream.Close() }()
		_, _ = io.Copy(connection, upstream)
	}))
}

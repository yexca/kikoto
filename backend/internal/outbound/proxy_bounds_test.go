package outbound

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestProxyCONNECTCancellationClosesPendingHandshake(t *testing.T) {
	received := make(chan struct{})
	closed := make(chan struct{})
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = connection.Close(); close(closed) }()
		close(received)
		_, _ = io.Copy(io.Discard, connection)
	}))
	defer proxyServer.Close()
	proxyURL, _ := ParseProxyURL(proxyServer.URL)
	policy, err := NewPolicy([]Destination{{URL: "http://source.test"}}, Options{Proxy: proxyURL, Resolver: publicTestResolver()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://source.test/file", nil)
	result := make(chan error, 1)
	client := policy.Client(nil, 5*time.Second)
	defer client.CloseIdleConnections()
	go func() {
		response, err := client.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- err
	}()
	select {
	case <-received:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not receive CONNECT")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled request error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt the proxy handshake")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("cancelled handshake kept the connection open")
	}
}

func TestProxyCONNECTRejectsOversizedResponseHeaders(t *testing.T) {
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Synthetic", strings.Repeat("a", maxResponseHeaderBytes))
		w.WriteHeader(http.StatusOK)
	}))
	defer proxyServer.Close()
	proxyURL, _ := ParseProxyURL(proxyServer.URL)
	policy, err := NewPolicy([]Destination{{URL: "http://source.test"}}, Options{Proxy: proxyURL, Resolver: publicTestResolver()})
	if err != nil {
		t.Fatal(err)
	}
	client := policy.Client(nil, time.Second)
	defer client.CloseIdleConnections()
	if _, err := client.Get("http://source.test/file"); err == nil || !strings.Contains(err.Error(), "invalid CONNECT response") {
		t.Fatalf("oversized CONNECT headers error = %v", err)
	}
}

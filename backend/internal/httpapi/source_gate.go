package httpapi

import (
	"context"
	"io"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type sourceRequestGate struct {
	mu    sync.Mutex
	lanes map[string]*sourceRequestLane
}

type sourceRequestLane struct {
	mu           sync.Mutex
	lastStarted  time.Time
	blockedUntil time.Time
}

type sourceGateTransport struct {
	server *Server
	base   http.RoundTripper
}

type sourceGateBody struct {
	io.ReadCloser
	once    sync.Once
	release func()
}

func (body *sourceGateBody) Read(buffer []byte) (int, error) {
	read, err := body.ReadCloser.Read(buffer)
	if err == io.EOF {
		body.once.Do(body.release)
	}
	return read, err
}

func newSourceRequestGate() *sourceRequestGate {
	return &sourceRequestGate{lanes: map[string]*sourceRequestLane{}}
}

func (g *sourceRequestGate) lane(key string) *sourceRequestLane {
	g.mu.Lock()
	defer g.mu.Unlock()
	if lane := g.lanes[key]; lane != nil {
		return lane
	}
	lane := &sourceRequestLane{}
	g.lanes[key] = lane
	return lane
}

func (t *sourceGateTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	lane := t.server.sourceGate.lane(canonicalSourceOrigin(request.URL))
	lane.mu.Lock()
	release := lane.mu.Unlock
	delay := t.server.remoteRequestDelayDuration(request.Context())
	waitUntil := lane.blockedUntil
	if next := lane.lastStarted.Add(delay); next.After(waitUntil) {
		waitUntil = next
	}
	if wait := time.Until(waitUntil); wait > 0 {
		if err := sleepContext(request.Context(), wait); err != nil {
			release()
			return nil, err
		}
	}
	lane.lastStarted = time.Now()
	response, err := t.base.RoundTrip(request)
	if err != nil {
		release()
		return nil, err
	}
	if isRetryableRemoteStatus(response.StatusCode) {
		blockedFor := retryAfterDuration(response.Header.Get("Retry-After"))
		if blockedFor <= 0 {
			blockedFor = t.server.remoteBackoffDuration(request.Context(), response, 0)
		}
		if until := time.Now().Add(blockedFor); until.After(lane.blockedUntil) {
			lane.blockedUntil = until
		}
	}
	response.Body = &sourceGateBody{ReadCloser: response.Body, release: release}
	return response, nil
}

func (body *sourceGateBody) Close() error {
	err := body.ReadCloser.Close()
	body.once.Do(body.release)
	return err
}

func (s *Server) sourceHTTPClient(timeout time.Duration) *http.Client {
	transport := &sourceGateTransport{server: s, base: http.DefaultTransport}
	return &http.Client{Transport: transport, Timeout: timeout}
}

func canonicalSourceOrigin(value *url.URL) string {
	if value == nil {
		return "unknown"
	}
	return strings.ToLower(value.Scheme + "://" + value.Host)
}

func sourceResourceKey(apiURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "remote:" + strings.ToLower(strings.TrimSpace(apiURL))
	}
	return "remote:" + canonicalSourceOrigin(parsed)
}

func (s *Server) remoteRequestDelayDuration(ctx context.Context) time.Duration {
	base := s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)
	randomRange := s.settingFloatContext(ctx, "remote_request_delay_random_seconds", 1.5)
	if base < 0 {
		base = 0
	}
	if randomRange < 0 {
		randomRange = 0
	}
	delay := time.Duration(base * float64(time.Second))
	if randomRange > 0 {
		delay += time.Duration(rand.Float64() * randomRange * float64(time.Second))
	}
	return delay
}

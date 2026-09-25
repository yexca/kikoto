package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/outbound"
)

type sourceRequestGate struct {
	mu      sync.Mutex
	lanes   map[string]*sourceRequestLane
	origins map[string]*sourceOriginState
}

type sourceRequestLane struct {
	mu          sync.Mutex
	lastStarted time.Time
	slots       chan struct{}
	waiters     chan struct{}
}

var errSourceRequestQueueFull = errors.New("remote request queue is full")

const sourceRequestQueueSize = 32

// sourceOriginBlockInlineWait is the longest origin block a request waits out
// in place. A longer block fails fast with sourceBackoffError so the caller
// releases its lane slot, and a workflow job releases the single job worker,
// instead of sleeping until the origin accepts requests again.
const sourceOriginBlockInlineWait = 5 * time.Second

// sourceBackoffError reports that a request was not sent because its origin
// asked clients to wait. Until is bounded by remote_max_backoff_seconds.
type sourceBackoffError struct {
	Until time.Time
}

func (e sourceBackoffError) Error() string {
	return "remote source asked to retry later"
}

type sourceOriginState struct {
	mu           sync.Mutex
	blockedUntil time.Time
}

type sourceRequestClass uint8

const (
	sourceRequestInteractive sourceRequestClass = iota
	sourceRequestCrawl
	sourceRequestDownload
	sourceRequestPlayback
)

type sourceGateTransport struct {
	server *Server
	base   http.RoundTripper
	policy *outbound.Policy
	class  sourceRequestClass
}

type sourceGateBody struct {
	io.ReadCloser
	once    sync.Once
	release func()
	done    chan struct{}
}

type sourcePolicyErrorTransport struct {
	err error
}

func (body *sourceGateBody) Read(buffer []byte) (int, error) {
	read, err := body.ReadCloser.Read(buffer)
	if err != nil {
		body.releaseOnce()
	}
	return read, err
}

func (body *sourceGateBody) releaseOnce() {
	body.once.Do(func() {
		body.release()
		close(body.done)
	})
}

func (body *sourceGateBody) releaseWhenCanceled(ctx context.Context) {
	select {
	case <-ctx.Done():
		_ = body.Close()
	case <-body.done:
	}
}

func newSourceRequestGate() *sourceRequestGate {
	return &sourceRequestGate{
		lanes:   map[string]*sourceRequestLane{},
		origins: map[string]*sourceOriginState{},
	}
}

func (g *sourceRequestGate) lane(key string, class sourceRequestClass) *sourceRequestLane {
	laneKey := key
	switch class {
	case sourceRequestCrawl:
		laneKey += ":crawl"
	case sourceRequestDownload:
		laneKey += ":download"
	case sourceRequestPlayback:
		laneKey += ":playback"
	default:
		laneKey += ":interactive"
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if lane := g.lanes[laneKey]; lane != nil {
		return lane
	}
	concurrency := 1
	if class == sourceRequestPlayback {
		concurrency = 4
	}
	lane := &sourceRequestLane{slots: make(chan struct{}, concurrency), waiters: make(chan struct{}, sourceRequestQueueSize)}
	g.lanes[laneKey] = lane
	return lane
}

func (lane *sourceRequestLane) acquire(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case lane.waiters <- struct{}{}:
	default:
		return nil, errSourceRequestQueueFull
	}
	defer func() { <-lane.waiters }()
	select {
	case lane.slots <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-lane.slots
			return nil, err
		}
		return func() { <-lane.slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (g *sourceRequestGate) origin(key string) *sourceOriginState {
	g.mu.Lock()
	defer g.mu.Unlock()
	if origin := g.origins[key]; origin != nil {
		return origin
	}
	origin := &sourceOriginState{}
	g.origins[key] = origin
	return origin
}

func (t *sourceGateTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if err := t.policy.ValidateURL(request.URL); err != nil {
		return nil, err
	}
	originKey := canonicalSourceOrigin(request.URL)
	lane := t.server.sourceGate.lane(originKey, t.class)
	origin := t.server.sourceGate.origin(originKey)
	release, err := lane.acquire(request.Context())
	if err != nil {
		return nil, err
	}
	delay := time.Duration(0)
	if t.class == sourceRequestCrawl || t.class == sourceRequestDownload {
		delay = t.server.remoteRequestDelayDuration(request.Context())
	}
	waitUntil := origin.blockedUntilValue()
	if time.Until(waitUntil) > sourceOriginBlockInlineWait {
		release()
		return nil, sourceBackoffError{Until: waitUntil}
	}
	lane.mu.Lock()
	if next := lane.lastStarted.Add(delay); next.After(waitUntil) {
		waitUntil = next
	}
	lane.mu.Unlock()
	if wait := time.Until(waitUntil); wait > 0 {
		if err := sleepContext(request.Context(), wait); err != nil {
			release()
			return nil, err
		}
	}
	lane.mu.Lock()
	lane.lastStarted = time.Now()
	lane.mu.Unlock()
	response, err := t.base.RoundTrip(request)
	if err != nil {
		release()
		return nil, err
	}
	if isRetryableRemoteStatus(response.StatusCode) {
		// Retry-After is untrusted input; remoteBackoffDuration bounds it by
		// remote_max_backoff_seconds so one response cannot stall the origin.
		blockedFor := t.server.remoteBackoffDuration(request.Context(), response, 0)
		origin.blockFor(blockedFor)
		slog.Warn("remote source origin backing off",
			"origin", originKey,
			"status", response.StatusCode,
			"requested", outbound.RetryAfter(response.Header.Get("Retry-After"), time.Now()),
			"blocked_for", blockedFor)
	}
	body := &sourceGateBody{ReadCloser: response.Body, release: release, done: make(chan struct{})}
	response.Body = body
	go body.releaseWhenCanceled(request.Context())
	return response, nil
}

func (body *sourceGateBody) Close() error {
	err := body.ReadCloser.Close()
	body.releaseOnce()
	return err
}

func (transport sourcePolicyErrorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, transport.err
}

func (s *Server) sourceHTTPClient(source remoteSourceForUse, timeout time.Duration) *http.Client {
	return s.sourceClient(source, timeout, sourceRequestInteractive)
}

func (s *Server) sourceCrawlHTTPClient(source remoteSourceForUse, timeout time.Duration) *http.Client {
	return s.sourceClient(source, timeout, sourceRequestCrawl)
}

func (s *Server) sourceDownloadHTTPClient(source remoteSourceForUse, timeout time.Duration) *http.Client {
	return s.sourceClient(source, timeout, sourceRequestDownload)
}

func (s *Server) sourcePlaybackHTTPClient(source remoteSourceForUse, timeout time.Duration) *http.Client {
	return s.sourceClient(source, timeout, sourceRequestPlayback)
}

func (s *Server) sourceClient(source remoteSourceForUse, timeout time.Duration, class sourceRequestClass) *http.Client {
	policy, base, err := s.sourceTransports.load(source)
	if err != nil {
		return &http.Client{Transport: sourcePolicyErrorTransport{err: err}, Timeout: timeout}
	}
	transport := &sourceGateTransport{server: s, base: base, policy: policy, class: class}
	return policy.Client(transport, timeout)
}

func sourceOutboundPolicy(source remoteSourceForUse) (*outbound.Policy, error) {
	destinations := make([]outbound.Destination, 0, 3)
	for _, candidate := range []string{source.Endpoint.APIURL, source.Endpoint.BaseURL, source.Endpoint.FallbackURL} {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		destinations = append(destinations, outbound.Destination{URL: candidate, AllowPrivate: true})
	}
	return outbound.NewPolicy(destinations, outbound.Options{
		AllowPublicOrigins:  !source.Endpoint.RestrictOutboundHosts,
		AllowedHostPatterns: source.Endpoint.AllowedHostPatterns,
	})
}

func (state *sourceOriginState) blockedUntilValue() time.Time {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.blockedUntil
}

func (state *sourceOriginState) blockFor(duration time.Duration) {
	if duration <= 0 {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if until := time.Now().Add(duration); until.After(state.blockedUntil) {
		state.blockedUntil = until
	}
}

func canonicalSourceOrigin(value *url.URL) string {
	if origin, err := outbound.CanonicalOrigin(value); err == nil {
		return origin
	}
	return "unknown"
}

func sourceResourceKey(apiURL string) string {
	parsed, err := outbound.ParseHTTPURL(apiURL)
	if err != nil {
		return "remote:invalid"
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

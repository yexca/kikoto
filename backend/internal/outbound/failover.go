package outbound

import (
	"errors"
	"net/http"
	"sync"
	"time"
)

// failoverCooldown is how long a route that failed to answer stays behind the
// routes that have not, so one unreachable proxy does not add its connect
// timeout to every request.
const failoverCooldown = 30 * time.Second

// FailoverTransport sends each request through the first of several routes,
// such as one policy transport per configured proxy, that answers it. Routes
// are tried in priority order. A request moves to the next route only when the
// previous one produced no response, the failure was not a policy rejection,
// the request context is still live, and the request body can be replayed; an
// HTTP error status is an answer and is returned as is. An optional fallback
// route is always tried last, after every other route failed.
type FailoverTransport struct {
	// routes ends with the fallback route when hasFallback is set.
	routes      []http.RoundTripper
	hasFallback bool
	now         func() time.Time

	mu          sync.Mutex
	failedUntil []time.Time
}

// NewFailoverTransport returns a transport over routes in priority order. A
// single route is returned unchanged.
func NewFailoverTransport(routes ...http.RoundTripper) http.RoundTripper {
	if len(routes) == 1 {
		return routes[0]
	}
	return &FailoverTransport{
		routes:      append([]http.RoundTripper(nil), routes...),
		now:         time.Now,
		failedUntil: make([]time.Time, len(routes)),
	}
}

// NewFailoverTransportWithFallback returns a transport over routes in priority
// order that tries fallback only after every route failed. The fallback never
// enters the cooldown order, so it cannot move ahead of a recovered route.
func NewFailoverTransportWithFallback(fallback http.RoundTripper, routes ...http.RoundTripper) http.RoundTripper {
	all := append(append([]http.RoundTripper(nil), routes...), fallback)
	return &FailoverTransport{
		routes:      all,
		hasFallback: true,
		now:         time.Now,
		failedUntil: make([]time.Time, len(all)),
	}
}

func (t *FailoverTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if len(t.routes) == 0 {
		if request.Body != nil {
			_ = request.Body.Close()
		}
		return nil, violation("outbound failover has no routes")
	}
	var lastErr error
	for attempt, index := range t.order() {
		current := request
		if attempt > 0 {
			replay, ok := replayRequest(request)
			if !ok {
				return nil, lastErr
			}
			current = replay
		}
		response, err := t.routes[index].RoundTrip(current)
		if err == nil {
			t.mark(index, time.Time{})
			return response, nil
		}
		lastErr = err
		if errors.Is(err, ErrPolicyViolation) || request.Context().Err() != nil {
			return nil, err
		}
		t.mark(index, t.now().Add(failoverCooldown))
	}
	return nil, lastErr
}

// CloseIdleConnections closes idle connections on every route.
func (t *FailoverTransport) CloseIdleConnections() {
	for _, route := range t.routes {
		if closer, ok := route.(interface{ CloseIdleConnections() }); ok {
			closer.CloseIdleConnections()
		}
	}
}

// order lists routes that are not cooling down first, each group in priority
// order, so every route is still attempted when all of them failed recently.
// A fallback route always comes last.
func (t *FailoverTransport) order() []int {
	now := t.now()
	primary := len(t.routes)
	if t.hasFallback {
		primary--
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	ready := make([]int, 0, len(t.routes))
	cooling := make([]int, 0, len(t.routes))
	for index := range primary {
		if t.failedUntil[index].After(now) {
			cooling = append(cooling, index)
		} else {
			ready = append(ready, index)
		}
	}
	order := append(ready, cooling...)
	if t.hasFallback {
		order = append(order, primary)
	}
	return order
}

func (t *FailoverTransport) mark(index int, until time.Time) {
	t.mu.Lock()
	t.failedUntil[index] = until
	t.mu.Unlock()
}

func replayRequest(request *http.Request) (*http.Request, bool) {
	replay := request.Clone(request.Context())
	if request.Body == nil || request.Body == http.NoBody {
		return replay, true
	}
	if request.GetBody == nil {
		return nil, false
	}
	body, err := request.GetBody()
	if err != nil {
		return nil, false
	}
	replay.Body = body
	return replay, true
}

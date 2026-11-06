package httpapi

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// shutdownStreams holds the responses that last for as long as their client
// keeps them open: playback, live transcoding, and workflow event streams.
// They only read, so a service stop ends them at once instead of letting them
// hold the drain that requests which change state need.
type shutdownStreams struct {
	mu     sync.Mutex
	closed bool
	next   uint64
	ends   map[uint64]func()
}

// register records end, which closes one open stream. It reports false once
// the streams are closed, so a stream that starts during a stop is refused.
func (streams *shutdownStreams) register(end func()) (func(), bool) {
	streams.mu.Lock()
	defer streams.mu.Unlock()
	if streams.closed {
		return nil, false
	}
	if streams.ends == nil {
		streams.ends = map[uint64]func(){}
	}
	id := streams.next
	streams.next++
	streams.ends[id] = end
	return func() {
		streams.mu.Lock()
		defer streams.mu.Unlock()
		delete(streams.ends, id)
	}, true
}

// closeAll ends every registered stream. It holds the lock while ending them,
// so a stream that already returned and unregistered is never touched.
func (streams *shutdownStreams) closeAll() {
	streams.mu.Lock()
	defer streams.mu.Unlock()
	streams.closed = true
	for id, end := range streams.ends {
		end()
		delete(streams.ends, id)
	}
}

// endsOnShutdown marks handler as a stream response that a service stop ends
// at once. Its request context is cancelled with ErrShuttingDown and its
// connection's write deadline passes, because a write blocked on a client
// that stopped reading, such as a paused player, does not observe the context.
func (s *Server) endsOnShutdown(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancelCause(r.Context())
		defer cancel(nil)
		controller := http.NewResponseController(w)
		unregister, ok := s.lifetime.streams.register(func() {
			cancel(ErrShuttingDown)
			_ = controller.SetWriteDeadline(time.Now())
		})
		if !ok {
			writeAPIError(w, http.StatusServiceUnavailable, "service_stopping", "The server is stopping.", true)
			return
		}
		defer unregister()
		handler(w, r.WithContext(ctx))
	}
}

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A paused player stops reading, so the stream handler blocks in a write that
// does not observe its context. The stop must still end it at once.
func TestShutdownEndsStreamBlockedOnClientThatStoppedReading(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	writing := make(chan struct{})
	ended := make(chan error, 1)
	upstream := httptest.NewServer(server.endsOnShutdown(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		chunk := make([]byte, 64<<10)
		started := false
		for {
			if _, err := w.Write(chunk); err != nil {
				ended <- context.Cause(r.Context())
				return
			}
			if !started {
				started = true
				close(writing)
			}
		}
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(upstream.CloseClientConnections)

	response, err := http.Get(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	<-writing

	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case cause := <-ended:
		if !errors.Is(cause, ErrShuttingDown) {
			t.Fatalf("stream cancellation cause = %v, want ErrShuttingDown", cause)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream blocked on an unread response did not end when shutdown began")
	}
}

func TestStreamStartedDuringShutdownIsRefused(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	called := false
	handler := server.endsOnShutdown(func(http.ResponseWriter, *http.Request) { called = true })
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest(http.MethodGet, "/api/media/1/stream", nil))

	if called || response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"service_stopping"`) {
		t.Fatalf("stream during shutdown = called %v, %d %s; want a retryable service_stopping refusal", called, response.Code, response.Body.String())
	}
}

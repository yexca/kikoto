package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/httpapi"
)

type recordingBackground struct {
	stopped chan struct{}
}

func (b *recordingBackground) Shutdown(context.Context) error {
	close(b.stopped)
	return nil
}

func startServeUntilStopped(t *testing.T, handler http.Handler, timeout time.Duration) (string, context.CancelFunc, *recordingBackground, <-chan error) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	background := &recordingBackground{stopped: make(chan struct{})}
	result := make(chan error, 1)
	go func() { result <- serveUntilStopped(ctx, listener, newHTTPServer(handler), background, timeout) }()
	return "http://" + listener.Addr().String(), stop, background, result
}

func TestServeUntilStoppedDrainsInFlightRequestBeforeReturning(t *testing.T) {
	entered := make(chan struct{})
	finish := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-finish
		_, _ = io.WriteString(w, "done")
	})
	url, stop, background, result := startServeUntilStopped(t, handler, 10*time.Second)

	body := make(chan string, 1)
	go func() {
		response, err := http.Get(url)
		if err != nil {
			body <- "error: " + err.Error()
			return
		}
		defer func() { _ = response.Body.Close() }()
		data, _ := io.ReadAll(response.Body)
		body <- string(data)
	}()
	<-entered
	stop()
	<-background.stopped
	select {
	case err := <-result:
		t.Fatalf("serveUntilStopped returned %v while a request was still in flight", err)
	default:
	}

	close(finish)
	if got := <-body; got != "done" {
		t.Fatalf("in-flight response = %q, want it to complete during shutdown", got)
	}
	if err := <-result; err != nil {
		t.Fatalf("serveUntilStopped = %v", err)
	}
}

func TestServeUntilStoppedCancelsStreamingRequestsWithShutdownCause(t *testing.T) {
	entered := make(chan struct{})
	cause := make(chan error, 1)
	handler := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		cause <- context.Cause(r.Context())
	})
	url, stop, _, result := startServeUntilStopped(t, handler, 200*time.Millisecond)

	go func() {
		if response, err := http.Get(url); err == nil {
			_ = response.Body.Close()
		}
	}()
	<-entered
	stop()
	if err := <-cause; !errors.Is(err, httpapi.ErrShuttingDown) {
		t.Fatalf("streaming request cancellation cause = %v, want ErrShuttingDown", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("serveUntilStopped = %v", err)
	}
}

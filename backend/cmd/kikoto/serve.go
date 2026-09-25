package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/httpapi"
)

type backgroundWork interface {
	Shutdown(context.Context) error
}

func newHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

// serveUntilStopped serves HTTP until ctx ends, then stops within timeout:
// new connections are refused at once, background work stops and releases
// its jobs, and in-flight requests may finish. Streaming responses such as
// playback and live transcoding get half of the timeout before their request
// contexts are cancelled. It returns only after the drain has finished, so
// the caller may then close shared resources such as the database.
func serveUntilStopped(ctx context.Context, listener net.Listener, httpServer *http.Server, background backgroundWork, timeout time.Duration) error {
	requestCtx, cancelRequests := context.WithCancelCause(context.Background())
	defer cancelRequests(nil)
	httpServer.BaseContext = func(net.Listener) context.Context { return requestCtx }

	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.Serve(listener) }()

	select {
	case err := <-serveErr:
		stopCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		_ = background.Shutdown(stopCtx)
		return err
	case <-ctx.Done():
	}

	slog.Info("shutting down", "timeout", timeout)
	stopCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cancelStreams := time.AfterFunc(timeout/2, func() { cancelRequests(httpapi.ErrShuttingDown) })
	defer cancelStreams.Stop()

	var stopping sync.WaitGroup
	var httpErr, backgroundErr error
	stopping.Go(func() { httpErr = httpServer.Shutdown(stopCtx) })
	stopping.Go(func() { backgroundErr = background.Shutdown(stopCtx) })
	stopping.Wait()
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	if httpErr != nil {
		_ = httpServer.Close()
		slog.Warn("requests still open at shutdown deadline were closed", "error", httpErr)
	}
	if backgroundErr != nil {
		slog.Warn("background work still running at shutdown deadline; startup recovery resumes it", "error", backgroundErr)
	}
	if httpErr == nil && backgroundErr == nil {
		slog.Info("shutdown complete")
	}
	return nil
}

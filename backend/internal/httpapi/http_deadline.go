package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// apiFirstResponseBudget bounds how long an API request may run before it
// starts its response. Request contexts otherwise have no deadline, so a
// request waiting for a pooled database connection could wait forever and
// keep every later request, including authentication, queued behind it.
// Streaming responses are unaffected once their headers are written.
const apiFirstResponseBudget = 60 * time.Second

var errFirstResponseDeadline = errors.New("request exceeded its first-response budget")

// withFirstResponseDeadline cancels a request's context when the handler has
// not started responding within budget. Routes whose handler legitimately
// works longer before its first byte, such as synchronous transcodes, are
// matched by their registered mux pattern and keep an unbounded context.
func withFirstResponseDeadline(next http.Handler, mux *http.ServeMux, budget time.Duration, exemptPatterns map[string]bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		if exemptPatterns[pattern] {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithCancelCause(r.Context())
		defer cancel(nil)
		timer := time.AfterFunc(budget, func() {
			slog.Warn("api request exceeded first-response budget", "method", r.Method, "pattern", pattern, "budget", budget)
			cancel(errFirstResponseDeadline)
		})
		defer timer.Stop()
		next.ServeHTTP(&firstResponseWriter{ResponseWriter: w, timer: timer}, r.WithContext(ctx))
	})
}

// firstResponseWriter disarms the first-response deadline as soon as the
// handler begins its response.
type firstResponseWriter struct {
	http.ResponseWriter
	timer *time.Timer
}

func (w *firstResponseWriter) started() {
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
}

func (w *firstResponseWriter) WriteHeader(status int) {
	w.started()
	w.ResponseWriter.WriteHeader(status)
}

func (w *firstResponseWriter) Write(data []byte) (int, error) {
	w.started()
	return w.ResponseWriter.Write(data)
}

func (w *firstResponseWriter) Flush() {
	w.started()
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *firstResponseWriter) ReadFrom(source io.Reader) (int64, error) {
	w.started()
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		return readerFrom.ReadFrom(source)
	}
	return io.Copy(writerOnly{w}, source)
}

func (w *firstResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

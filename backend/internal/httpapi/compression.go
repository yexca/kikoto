package httpapi

import (
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipMinBytes is the smallest body worth compressing. Smaller responses are
// buffered and sent unchanged.
const gzipMinBytes = 1024

var gzipCompressibleTypes = map[string]bool{
	"application/json":          true,
	"application/manifest+json": true,
	"application/javascript":    true,
	"text/javascript":           true,
	"text/css":                  true,
	"text/html":                 true,
	"image/svg+xml":             true,
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		writer, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
		return writer
	},
}

// withGzip compresses eligible text responses for clients that accept gzip.
// The decision is made from the final response headers, so media, cover,
// HLS, and event-stream responses pass through untouched by content type.
// Range requests are never wrapped, keeping byte offsets meaningful.
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead || r.Header.Get("Range") != "" || gzipExcludedPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		writer := &gzipResponseWriter{ResponseWriter: w, acceptsGzip: acceptsGzip(r.Header.Values("Accept-Encoding"))}
		defer writer.finish()
		next.ServeHTTP(writer, r)
	})
}

// gzipExcludedPath skips routes that stream stored files or events. Their
// content types already prevent compression; the path check keeps a work file
// that happens to be SVG, HTML, or JSON byte-exact as well.
//
// Authentication responses are excluded to avoid a BREACH-style length oracle:
// a mobile login response carries a session token beside the reflected
// username. No other response embeds a credential or CSRF token.
func gzipExcludedPath(requestPath string) bool {
	switch {
	case strings.HasPrefix(requestPath, "/api/auth/"),
		strings.HasPrefix(requestPath, "/api/media/"),
		strings.HasPrefix(requestPath, "/api/assets/"),
		strings.HasSuffix(requestPath, "/events/stream"),
		strings.HasPrefix(requestPath, "/api/remote-sources/") && strings.HasSuffix(requestPath, "/media"):
		return true
	}
	return false
}

func acceptsGzip(values []string) bool {
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
			coding = strings.ToLower(strings.TrimSpace(coding))
			if coding != "gzip" && coding != "*" {
				continue
			}
			quality := strings.ReplaceAll(strings.ToLower(params), " ", "")
			if strings.HasPrefix(quality, "q=") {
				if q, err := strconv.ParseFloat(strings.TrimPrefix(quality, "q="), 64); err == nil && q <= 0 {
					continue
				}
			}
			return true
		}
	}
	return false
}

// gzipCompressibleResponse reports whether the representation could be sent
// gzip-encoded, which is also when the response varies by Accept-Encoding.
func gzipCompressibleResponse(header http.Header) bool {
	if header.Get("Content-Encoding") != "" || header.Get("Content-Range") != "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(header.Get("Content-Type"))
	return err == nil && gzipCompressibleTypes[strings.ToLower(mediaType)]
}

func gzipStatusEligible(status int, header http.Header) bool {
	if status < http.StatusOK || status == http.StatusNoContent || status == http.StatusPartialContent || status == http.StatusNotModified {
		return false
	}
	if length := header.Get("Content-Length"); length != "" {
		if size, err := strconv.ParseInt(length, 10, 64); err == nil && size < gzipMinBytes {
			return false
		}
	}
	return true
}

type gzipMode int

const (
	gzipUndecided gzipMode = iota
	gzipPassthrough
	gzipBuffering
	gzipCompressing
)

type gzipResponseWriter struct {
	http.ResponseWriter
	acceptsGzip bool
	status      int
	mode        gzipMode
	buffer      []byte
	gzip        *gzip.Writer
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	if w.mode != gzipUndecided {
		return
	}
	// Informational responses do not carry the final headers.
	if status >= 100 && status < 200 {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status
	header := w.Header()
	if gzipCompressibleResponse(header) {
		header.Add("Vary", "Accept-Encoding")
		if w.acceptsGzip && gzipStatusEligible(status, header) {
			w.mode = gzipBuffering
			return
		}
	}
	w.mode = gzipPassthrough
	w.ResponseWriter.WriteHeader(status)
}

func (w *gzipResponseWriter) Write(data []byte) (int, error) {
	if w.mode == gzipUndecided {
		if w.ResponseWriter.Header().Get("Content-Type") == "" {
			w.ResponseWriter.Header().Set("Content-Type", http.DetectContentType(data))
		}
		w.WriteHeader(http.StatusOK)
	}
	switch w.mode {
	case gzipBuffering:
		w.buffer = append(w.buffer, data...)
		if len(w.buffer) >= gzipMinBytes {
			if err := w.startGzip(); err != nil {
				return 0, err
			}
		}
		return len(data), nil
	case gzipCompressing:
		return w.gzip.Write(data)
	default:
		return w.ResponseWriter.Write(data)
	}
}

func (w *gzipResponseWriter) startGzip() error {
	header := w.Header()
	header.Del("Content-Length")
	header.Set("Content-Encoding", "gzip")
	w.ResponseWriter.WriteHeader(w.status)
	w.gzip = gzipWriterPool.Get().(*gzip.Writer)
	w.gzip.Reset(w.ResponseWriter)
	w.mode = gzipCompressing
	buffered := w.buffer
	w.buffer = nil
	if len(buffered) == 0 {
		return nil
	}
	_, err := w.gzip.Write(buffered)
	return err
}

// Flush commits a buffered compressible response so that a streaming handler
// still delivers its bytes immediately.
func (w *gzipResponseWriter) Flush() {
	if w.mode == gzipUndecided {
		w.WriteHeader(http.StatusOK)
	}
	if w.mode == gzipBuffering {
		_ = w.startGzip()
	}
	if w.mode == gzipCompressing {
		_ = w.gzip.Flush()
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// ReadFrom keeps the underlying writer's copy optimization for responses
// that are not compressed, such as static images served by http.ServeFile.
func (w *gzipResponseWriter) ReadFrom(source io.Reader) (int64, error) {
	if w.mode == gzipPassthrough {
		if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
			return readerFrom.ReadFrom(source)
		}
	}
	return io.Copy(writerOnly{w}, source)
}

type writerOnly struct{ io.Writer }

func (w *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *gzipResponseWriter) finish() {
	switch w.mode {
	case gzipBuffering:
		// The body stayed below the threshold: send it unchanged.
		w.ResponseWriter.WriteHeader(w.status)
		if len(w.buffer) > 0 {
			_, _ = w.ResponseWriter.Write(w.buffer)
		}
		w.buffer = nil
	case gzipCompressing:
		_ = w.gzip.Close()
		w.gzip.Reset(nil)
		gzipWriterPool.Put(w.gzip)
		w.gzip = nil
	}
}

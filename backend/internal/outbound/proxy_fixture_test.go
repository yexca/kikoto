package outbound

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Answers a tunneled HTTP request without making any external connections.
func newRespondingProxy(t *testing.T, onConnect func(*http.Request), destination http.Handler) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodConnect || request.Host != net.JoinHostPort(testfixture.PublicIPv4().String(), "80") {
			t.Errorf("proxy target = %s %q, want CONNECT to validated numeric address", request.Method, request.Host)
			http.Error(w, "invalid target", http.StatusBadRequest)
			return
		}
		if onConnect != nil {
			onConnect(request)
		}
		connection, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = connection.Close() }()
		_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffered.Flush()
		inner, err := http.ReadRequest(buffered.Reader)
		if err != nil {
			t.Errorf("read tunneled request: %v", err)
			return
		}
		defer func() { _ = inner.Body.Close() }()
		response := httptest.NewRecorder()
		destination.ServeHTTP(response, inner)
		result := response.Result()
		defer func() { _ = result.Body.Close() }()
		result.Close = true
		_ = result.Write(connection)
		_, _ = io.Copy(io.Discard, inner.Body)
	}))
}
